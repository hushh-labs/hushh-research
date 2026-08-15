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
 * Sequence — an original, cinematic logo-reveal treatment (paced like a
 * premium streaming intro; no logo, animation, palette, or sound copied
 * from any specific one): the screen opens on a near-black background;
 * thin purple/pink/blue light streaks rise and sweep toward the centre,
 * each blurred and moving at a different depth so the convergence reads
 * as dimensional rather than flat; they gather into a soft glow bloom,
 * out of which the 🤫 mark and "Hushh One." wordmark resolve from a blur
 * into sharp focus; that holds for 1.5s; it then slowly cross-dissolves
 * over 750ms — with a soft blur and a light upward drift, never an
 * instant swap — into "Hi, {first name}" / "Welcome to One." (the real
 * signed-in user's first name — already available here via Firebase auth,
 * which resolves before the vault ever does; "Hi there" is only a
 * fallback for the rare case neither a display name nor an email
 * local-part exists); that holds for another 1.5s; the whole screen then
 * fades gently — opacity only, no colour keyframe to jump through, so
 * there is no flash of any kind — and only THEN does `VaultLockGuard`
 * mount for the first time and reveal the vault screen underneath.
 *
 * Replay behaviour comes for free from how Next.js layouts work: this
 * component lives in the `/one` layout, which stays mounted across every
 * internal navigation between `/one/*` pages (Next only swaps the leaf
 * page), so the mount-once effect below never re-fires for in-app
 * navigation, and reading `useAuth()` here for the greeting does not
 * restart it either — the timers only ever depend on mount, not on any
 * auth/setup state re-rendering this component. The effect only re-fires
 * when the layout itself remounts — a real page load or refresh of `/one`,
 * or a fresh navigation into the section from outside it — which is
 * exactly "the app is opened."
 *
 * Fully skipped under prefers-reduced-motion — `VaultLockGuard` and
 * `{children}` mount immediately with no overlay at all.
 * ──────────────────────────────────────────────────────────── */

type Phase = "idle" | "sweep" | "greet1" | "greet2" | "exit";

const SWEEP_DELAY_MS = 20;
const CONVERGE_TO_MARK_MS = 1250;
const GREET1_HOLD_MS = 1500;
const GREET2_HOLD_MS = 1500;
const EXIT_DURATION_MS = 420;
const EXIT_BUFFER_MS = 80;

const GREET1_AT_MS = SWEEP_DELAY_MS + CONVERGE_TO_MARK_MS;
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
    if (prefersReducedMotion()) {
      setIntroComplete(true);
      return;
    }

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
      <div className={styles.beams}>
        <div className={`${styles.streak} ${styles.streakPurpleFar}`} />
        <div className={`${styles.streak} ${styles.streakPink}`} />
        <div className={`${styles.streak} ${styles.streakBlue}`} />
        <div className={`${styles.streak} ${styles.streakPurpleNear}`} />
      </div>
      <div className={styles.halo} />
      <div className={styles.iconWrap}>
        <span className={styles.icon}>🤫</span>
      </div>
      <div className={styles.textStack}>
        <p className={styles.label1}>
          Hushh <span className={styles.label1Accent}>One.</span>
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
