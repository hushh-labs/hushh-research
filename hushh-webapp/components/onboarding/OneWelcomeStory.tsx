"use client";

import Image from "next/image";
import type { ReactNode, RefObject } from "react";
import styles from "./IntroStep.module.css";

const ASSET_ROOT = "/onboarding/welcome-stitch";

/** The welcome artwork is decorative; the headline and controls remain real text. */
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
    <div className={styles.composition}>
      <div
        className={styles.welcomeContent}
        data-motion={motionEnabled ? "animated" : "static"}
        aria-hidden="true"
      >
        <div className={styles.artworkCanvas}>
          <div className={styles.skyOrb} />
          <Image
            className={styles.oneWordmark}
            src="/onboarding/figma/one-light.svg"
            alt=""
            width={221}
            height={91}
            priority
          />
          <svg className={styles.doodle} viewBox="0 0 390 380" fill="none">
            <path d="M10 128C55 74 95 96 113 116C139 146 101 176 92 145C84 116 161 55 262 80C309 91 324 119 365 104" />
            <path d="M283 299c20-16 43-14 62 7" />
            <circle cx="343" cy="75" r="4" />
            <circle cx="70" cy="274" r="3" />
          </svg>
          <Image
            className={styles.mascot}
            src={ASSET_ROOT + "/one-mascot.png"}
            alt=""
            width={1254}
            height={1254}
            priority
          />
          <div className={[styles.cue, styles.cueCalendar].join(" ")}>
            <span className={styles.cueIcon}>
              <Image src={ASSET_ROOT + "/calendar.svg"} alt="" width={20} height={20} />
            </span>
            <span>Find a time</span>
          </div>
          <div className={[styles.cue, styles.cueMail].join(" ")}>
            <span className={styles.cueIcon}>
              <Image src={ASSET_ROOT + "/mail.svg"} alt="" width={20} height={20} />
            </span>
            <span>Catch me up</span>
          </div>
          <div className={[styles.cue, styles.cueConsent].join(" ")}>
            <span className={styles.cueIcon}>
              <Image src={ASSET_ROOT + "/consent.svg"} alt="" width={20} height={20} />
            </span>
            <span>My access</span>
          </div>
        </div>
      </div>
      <div className={styles.bottom}>
        <div ref={headingRef} tabIndex={-1} className={styles.hero}>
          <h1>Your private AI agent for everyday life.</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
