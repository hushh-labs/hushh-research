"use client";

import type { ReactNode } from "react";
import Image from "next/image";

import { cn } from "@/lib/utils";

import styles from "./setup-v10-surface.module.css";

export type SetupV10Stage = "hub" | "ai" | "lock" | "recovery";

type SetupV10IconName =
  | "arrow-left"
  | "arrow-right"
  | "chevron-right"
  | "more"
  | "plug"
  | "shield"
  | "lock"
  | "key"
  | "check";

const iconPaths: Record<SetupV10IconName, ReactNode> = {
  "arrow-left": <path d="m14.5 5-7 7 7 7" />,
  "arrow-right": <path d="M4 12h16m-6-6 6 6-6 6" />,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  more: <><circle cx="5" cy="12" r=".85" /><circle cx="12" cy="12" r=".85" /><circle cx="19" cy="12" r=".85" /></>,
  plug: <><path d="M7 2v6M17 2v6M5 8h14v3a7 7 0 0 1-14 0V8ZM12 18v4" /></>,
  shield: <><path d="m12 3 8 3v5.7c0 5-3.2 8.2-8 10.3-4.8-2.1-8-5.3-8-10.3V6Z" /><path d="m8.8 12.3 2.3 2.3 4.3-4.3" /></>,
  lock: <><rect x="5.5" y="10.5" width="13" height="10" rx="2" /><path d="M8.5 10.5V7a3.5 3.5 0 0 1 7 0v3.5" /></>,
  key: <><circle cx="7.4" cy="15.6" r="4.2" /><path d="M10.4 12.6 21 2m-4 4 3 3m-6 0 2.5 2.5" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
};

export function SetupV10Icon({
  name,
  size = 20,
  className,
}: {
  name: SetupV10IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {iconPaths[name]}
    </svg>
  );
}

function GeminiStar() {
  return (
    <svg aria-hidden="true" viewBox="0 0 48 48" width="21" height="21">
      <defs>
        <linearGradient id="setup-v10-gemini" x1="6" y1="5" x2="42" y2="43" gradientUnits="userSpaceOnUse">
          <stop stopColor="#EA4335" />
          <stop offset=".28" stopColor="#FBBC05" />
          <stop offset=".5" stopColor="#34A853" />
          <stop offset=".74" stopColor="#4285F4" />
          <stop offset="1" stopColor="#A142F4" />
        </linearGradient>
      </defs>
      <path fill="url(#setup-v10-gemini)" d="M24 0c0 13.255-10.745 24-24 24 13.255 0 24 10.745 24 24 0-13.255 10.745-24 24-24C34.745 24 24 13.255 24 0Z" />
    </svg>
  );
}

/** The original mascot posters are already shipped by the onboarding bundle. */
export function SetupV10Scene({ stage }: { stage: SetupV10Stage }) {
  const mascot = stage === "ai" ? "working" : stage === "lock" ? "connected" : "answering";
  const firstTag = stage === "hub" ? "Choose your AI" : stage === "ai" ? "Gemini" : stage === "lock" ? "Only you" : "Recovery key";
  const secondTag = stage === "hub" ? "Made for you" : stage === "ai" ? "Your choice" : stage === "lock" ? "Protected" : "Keep it safe";
  const firstIcon = stage === "hub" || stage === "ai" ? "plug" : stage === "lock" ? "lock" : "key";
  const secondIcon = stage === "ai" ? "plug" : stage === "hub" ? "check" : "shield";

  return (
    <div className={cn(styles.scene, styles[`scene_${stage}`])} aria-hidden="true">
      <div className={styles.artboard}>
        <svg className={styles.shapes} viewBox="0 0 440 355" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M45 126c0-30 23-54 53-54h92c27 0 46 18 46 44v100c0 30-20 49-50 49H99c-32 0-54-20-54-51V126Z" fill="#F7B5D5" />
          <path d="M265 70c6-17 25-23 39-13 13-12 34-6 39 9 18 0 29 17 20 33 14 12 11 31-5 36 2 20-14 31-31 24-15 14-31 10-38-7-22 2-34-13-29-32-16-12-11-33 5-37-4-5-4-9 0-13Z" fill="#FFDC72" />
          <path d="M111 235c16-16 38-13 48 2 18-8 35 3 37 21 20 6 23 25 10 39-6 10-17 13-29 9-18 13-38 5-43-11-22 3-36-11-33-30-11-13-8-24 10-30Z" fill="#B8CFFF" />
          <path d="M336 221c19-5 33 5 37 24l12 52-60 16-22-59c-5-15 7-27 33-33Z" fill="#FF745F" />
          <path d="M70 58 65 45m26 13V42m21 18 8-12M365 190c12-7 25-5 35 3m-30 7c9-1 19 2 27 9" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" />
          <circle cx="362" cy="77" r="4" fill="#0071E3" /><circle cx="69" cy="308" r="3" fill="#FF745F" />
        </svg>
        {stage === "lock" ? <span className={styles.lockDisc}><SetupV10Icon name="lock" size={40} /></span> : null}
        {stage === "recovery" ? <span className={styles.keyDisc}><SetupV10Icon name="key" size={40} /></span> : null}
        <Image
          className={styles.mascot}
          src={`/onboarding/intro-v2/${mascot}-poster.png`}
          alt=""
          width={512}
          height={512}
          sizes="(min-width: 900px) 360px, 220px"
          loading="eager"
          draggable={false}
          decoding="async"
        />
        <span className={cn(styles.tag, styles.tagFirst)}>
          {stage === "ai" ? <GeminiStar /> : <span className={styles.blueTile}><SetupV10Icon name={firstIcon} size={16} /></span>}
          {firstTag}
        </span>
        <span className={cn(styles.tag, styles.tagSecond)}>
          <span className={stage === "ai" ? styles.blueTile : styles.mintTile}>
            <SetupV10Icon name={secondIcon} size={16} />
          </span>
          {secondTag}
        </span>
      </div>
    </div>
  );
}

type SetupV10SurfaceProps = {
  stage: SetupV10Stage;
  children: ReactNode;
  onBack?: () => void;
  backDisabled?: boolean;
  onMenu?: () => void;
  menuDisabled?: boolean;
  menuOpen?: boolean;
  menuContent?: ReactNode;
  className?: string;
  contentClassName?: string;
};

/** Shared visual layer; the caller remains the authority for setup state and mutations. */
export function SetupV10Surface({
  stage,
  children,
  onBack,
  backDisabled = false,
  onMenu,
  menuDisabled = false,
  menuOpen = false,
  menuContent,
  className,
  contentClassName,
}: SetupV10SurfaceProps) {
  return (
    <main className={cn(styles.surface, className)} data-setup-v10-stage={stage}>
      {onBack || onMenu ? (
        <div className={styles.chrome}>
          {onBack ? (
            <button type="button" className={styles.roundButton} aria-label="Go back" onClick={onBack} disabled={backDisabled}>
              <SetupV10Icon name="arrow-left" size={21} />
            </button>
          ) : <span />}
          {onMenu ? (
            <div className={styles.menuWrap}>
              <button type="button" className={styles.roundButton} aria-label="Account actions" aria-expanded={menuOpen} onClick={onMenu} disabled={menuDisabled}>
                <SetupV10Icon name="more" size={20} />
              </button>
              {menuOpen && menuContent ? <div className={styles.menu}>{menuContent}</div> : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className={styles.layout}>
        <div className={styles.art} data-setup-v10-art><SetupV10Scene stage={stage} /></div>
        <section className={cn(styles.content, contentClassName)} aria-label="Setup form" data-setup-v10-content>
          {children}
        </section>
      </div>
    </main>
  );
}
