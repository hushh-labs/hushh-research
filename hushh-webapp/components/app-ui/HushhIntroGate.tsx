"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import styles from "./HushhIntroGate.module.css";

/* ────────────────────────────────────────────────────────────
 * HushhIntroGate
 *
 * The app's real first screen for the `/one` section, and the ONLY splash
 * trigger in the app — mounted in `app/one/layout.tsx`, one level ABOVE
 * `OneAuthGate` (and therefore above `VaultLockGuard` and every other
 * auth/vault guard). While the intro is playing, `VaultLockGuard` and the
 * rest of the protected app are not rendered at all — not hidden
 * underneath, not mounted in the background, simply not in the tree —
 * so nothing they do (an auth-loading flicker, a vault re-check re-render)
 * can restart, extend, or remove the intro: its own phase timers live here,
 * one level up, entirely untouched by whatever mounts below it once it's
 * done. `VaultLockGuard` only mounts, for the first time, the instant this
 * component's own animation finishes — there is no second trigger anywhere
 * else in the app, and `VaultLockGuard`'s unlock success handler
 * intentionally does nothing: a successful unlock simply lets the guard's
 * own render fall through to `{children}` (the home page), with no splash
 * of any kind.
 *
 * Sequence — a soft splash, not a cinematic logo reveal: a slow mist of
 * blurred purple/pink/blue drifts up from below the screen through the
 * centre and out past the top (~2.5s, Zomato-referenced motion, an
 * original organic-cloud treatment); the 🤫 mark and "Hussh One." reveal
 * gradually through the still-moving mist; that holds for 1.5s; it then
 * slowly cross-dissolves over 750ms — with a soft blur and a light upward
 * drift, never an instant swap — into "Hi, {first name}" / "Welcome to
 * One." (the real signed-in user's first name — already available here
 * via Firebase auth, which resolves before the vault ever does; "Hi
 * there" is only a fallback for the rare case neither a display name nor
 * an email local-part exists); that holds for another 1.5s; the whole
 * screen then fades gently to reveal whatever's already mounted
 * underneath — and only THEN does `VaultLockGuard` mount for the first
 * time and reveal the vault screen.
 *
 * Plays once, ever, per browser — not on every open or refresh. A
 * `localStorage` flag (`INTRO_SEEN_KEY`) is set the moment this decides
 * to actually play the intro; every later mount (a new tab, a refresh
 * next week, a different day) checks that flag first and, if set, skips
 * straight to `{children}` with no overlay at all — the same bailout
 * `prefers-reduced-motion` already used. Within a single "first play"
 * session this component still lives in the `/one` layout, which stays
 * mounted across every internal navigation between `/one/*` pages (Next
 * only swaps the leaf page), so the mount-once effect below never
 * re-fires mid-navigation either; reading `useAuth()` here for the
 * greeting does not restart it, since the timers only ever depend on
 * mount, not on any auth/setup state re-rendering this component.
 *
 * Fully skipped under prefers-reduced-motion too — `VaultLockGuard` and
 * `{children}` mount immediately with no overlay at all.
 * ──────────────────────────────────────────────────────────── */

const INTRO_SEEN_KEY = "hushh.one.intro.seen.v1";

function hasSeenIntro(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    // Storage blocked (private browsing, disabled cookies/storage, etc).
    // Fail open to "not seen" rather than throwing — worst case the
    // splash plays again, which is the pre-existing behaviour.
    return false;
  }
}

function markIntroSeen(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    // Nothing to fall back to; a future mount will just play it again.
  }
}

type Phase = "idle" | "sweep" | "greet1" | "greet2" | "exit";

const SWEEP_DELAY_MS = 20;
const MIST_TO_MARK_MS = 1250;
const GREET1_HOLD_MS = 1500;
const GREET2_HOLD_MS = 1500;
const EXIT_DURATION_MS = 420;
const EXIT_BUFFER_MS = 80;

const GREET1_AT_MS = SWEEP_DELAY_MS + MIST_TO_MARK_MS;
const GREET2_AT_MS = GREET1_AT_MS + GREET1_HOLD_MS;
const EXIT_AT_MS = GREET2_AT_MS + GREET2_HOLD_MS;
const TOTAL_DURATION_MS = EXIT_AT_MS + EXIT_DURATION_MS + EXIT_BUFFER_MS;

function resolveFirstName(
  displayName?: string | null,
  email?: string | null,
): string | null {
  const raw = displayName?.trim() || email?.split("@")[0]?.trim() || "";
  const first = raw
    .replace(/[._-]+/g, " ")
    .split(/\s+/)
    .find(Boolean);
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function HushhIntroGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [introComplete, setIntroComplete] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const firedRef = useRef(false);

  useEffect(() => {
    if (prefersReducedMotion() || hasSeenIntro()) {
      setIntroComplete(true);
      return;
    }

    markIntroSeen();

    const timers: number[] = [];
    timers.push(window.setTimeout(() => setPhase("sweep"), SWEEP_DELAY_MS));
    timers.push(window.setTimeout(() => setPhase("greet1"), GREET1_AT_MS));
    timers.push(window.setTimeout(() => setPhase("greet2"), GREET2_AT_MS));
    timers.push(window.setTimeout(() => setPhase("exit"), EXIT_AT_MS));
    timers.push(
      window.setTimeout(() => {
        if (firedRef.current) return;
        firedRef.current = true;
        setIntroComplete(true);
      }, TOTAL_DURATION_MS),
    );

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
    // Runs once on mount only — this is the single source of truth for the
    // whole sequence. Deliberately NOT depending on `user`: the greeting
    // reads `user` fresh at render time below, but the timers themselves
    // must never restart just because auth/setup state changes underneath.
  }, []);

  if (introComplete) {
    return <>{children}</>;
  }

  const firstName = resolveFirstName(user?.displayName, user?.email);

  return (
    <div aria-hidden="true" className={styles.root} data-phase={phase}>
      <div className={styles.mist}>
        <div className={`${styles.blob} ${styles.blobPurple}`} />
        <div className={`${styles.blob} ${styles.blobPink}`} />
        <div className={`${styles.blob} ${styles.blobBlue}`} />
      </div>
      <div className={styles.halo} />
      <div className={styles.iconWrap}>
        <span className={styles.icon}>🤫</span>
      </div>
      <div className={styles.textStack}>
        <p className={styles.label1}>
          Hussh <span className={styles.label1Accent}>One.</span>
        </p>
        <div className={styles.label2}>
          <p className={`${styles.greetingLine} ${styles.greetingLineFirst}`}>
            {firstName ? `Hi, ${firstName}` : "Hi there"}
          </p>
          <p className={`${styles.greetingLine} ${styles.greetingLineSecond}`}>
            Welcome to <span className={styles.greetingAccent}>One.</span>
          </p>
        </div>
      </div>
    </div>
  );
}
