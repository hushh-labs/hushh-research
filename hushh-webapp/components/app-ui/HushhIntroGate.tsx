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
 * Sequence — a single soft greeting, not a two-screen cinematic reveal:
 * the 🤫 mark and "Hi, {first name}" / "Welcome to One." appear together,
 * hold long enough to read, then fade gently to reveal whatever's mounted
 * underneath.
 * The real signed-in user's first name is already available here via
 * Firebase auth; "Hi there" is only a fallback for the rare case neither a
 * display name nor an email local-part exists. Only THEN does
 * `VaultLockGuard` mount for the first time and reveal the vault screen.
 *
 * Plays once per browser tab, not once per mount of this layout — those are
 * NOT the same thing. `/one` is a distinct Next.js route segment from `/ria`,
 * `/connect`, and `/marketplace`, so crossing between them unmounts and
 * remounts this layout, same as a real page load would. A `useRef`/`useState`
 * guard resets on every one of those remounts, and did until this comment:
 * back out of RIA (a `push` navigation, never a reload) replayed the full
 * greeting sequence, which read exactly like the back button had given up
 * and relaunched the app rather than retraced a step.
 *
 * `hasIntroPlayedThisSession` below is a plain module-level variable, not
 * React state, so it survives this component unmounting and remounting --
 * it only resets when the JS module itself is re-evaluated, which is a real
 * page load or refresh. That is what "the app is opened" should have meant
 * all along; crossing a route segment boundary while the tab stays open
 * never is that, whichever direction the crossing runs.
 *
 * Fully skipped under prefers-reduced-motion — `VaultLockGuard` and
 * `{children}` mount immediately with no overlay at all.
 * ──────────────────────────────────────────────────────────── */

type Phase = "idle" | "greet" | "exit";

const SWEEP_DELAY_MS = 20;
const GREETING_HOLD_MS = 1900;
const EXIT_DURATION_MS = 360;
const EXIT_BUFFER_MS = 80;

const EXIT_AT_MS = SWEEP_DELAY_MS + GREETING_HOLD_MS;
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

// Deliberately outside the component -- see the file header. React state
// would reset on every remount; this must not.
let hasIntroPlayedThisSession = false;

// Test-only escape hatch. Nothing in the app calls this -- a real reset
// only ever happens via a fresh page load, which re-evaluates this module
// from scratch. Exported so a test can exercise "first mount this session"
// more than once without spinning up a real navigation.
export function __resetHushhIntroGateForTests(): void {
  hasIntroPlayedThisSession = false;
}

export function HushhIntroGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [introComplete, setIntroComplete] = useState(
    () => hasIntroPlayedThisSession,
  );
  const [phase, setPhase] = useState<Phase>("idle");
  const firedRef = useRef(false);

  useEffect(() => {
    if (hasIntroPlayedThisSession) return;

    if (prefersReducedMotion()) {
      hasIntroPlayedThisSession = true;
      setIntroComplete(true);
      return;
    }

    const timers: number[] = [];
    timers.push(window.setTimeout(() => setPhase("greet"), SWEEP_DELAY_MS));
    timers.push(window.setTimeout(() => setPhase("exit"), EXIT_AT_MS));
    timers.push(
      window.setTimeout(() => {
        if (firedRef.current) return;
        firedRef.current = true;
        hasIntroPlayedThisSession = true;
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
    <div
      aria-hidden="true"
      className={styles.root}
      data-phase={phase}
      data-testid="hushh-intro-gate"
    >
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
