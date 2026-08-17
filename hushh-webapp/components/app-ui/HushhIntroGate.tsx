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
 * gradually through the still-moving mist; that holds for 1.5s
 * (`GREET1_HOLD_MS`); it then slowly cross-dissolves over 750ms — with a
 * soft blur and a light upward drift, never an instant swap — into
 * "Hi, {first name}" / "Welcome to One." (the real signed-in user's first
 * name — already available here via Firebase auth, which resolves before
 * the vault ever does; "Hi there" is only a fallback for the rare case
 * neither a display name nor an email local-part exists); that holds for
 * another 1.5s (`GREET2_HOLD_MS`); the whole screen then fades gently to
 * reveal whatever's already mounted underneath — and only THEN does
 * `VaultLockGuard` mount for the first time and reveal the vault screen.
 * `TOTAL_DURATION_MS` (~4.8s) is the sum of every phase below; every CSS
 * transition/animation duration in the stylesheet is paced to match (see
 * that file's own header) so nothing is ever cut off mid-transition by a
 * phase change firing before its predecessor's motion has finished.
 *
 * Plays only for a signed-in user who hasn't unlocked their vault yet this
 * login — never for a logged-out visitor, and never again on refresh,
 * navigation, or repeatedly within the same signed-in session. Three
 * things working together:
 *
 * - No uid, no splash: `shouldPlayIntro()` returns false outright when
 *   `useAuth()` has no signed-in user, so a visitor who lands on `/one`
 *   logged out sees nothing here — `{children}` (OneAuthGate) mounts
 *   immediately and handles the redirect to `/login` on its own, with no
 *   intro ever appearing in front of it. The intro's place in the flow is
 *   strictly after a real login and before the vault, never before login.
 * - This component lives in the `/one` layout, which stays mounted across
 *   every internal navigation between `/one/*` pages (Next only swaps the
 *   leaf page), so the mount-once effect below never re-fires for in-app
 *   navigation — there is nothing to gate there, it simply never runs
 *   again until the layout itself remounts (a real page load/refresh of
 *   `/one`, or a fresh navigation into the section from outside it).
 * - On every one of those remounts, once a uid is known, `shouldPlayIntro`
 *   compares it against the uid stored in `localStorage` (`LAST_UID_KEY`)
 *   the last time the intro actually played, and skips straight to
 *   `{children}` when they match. A refresh or a fresh page load while the
 *   same account is still signed in is the same login by this measure and
 *   is skipped; a different uid — a real sign-out followed by a sign-in,
 *   or a different account entirely — is not, and replays. This is keyed
 *   to identity, not a session timer, because "genuinely fresh" means a
 *   new login, not merely time having passed: `useAuth()` has already
 *   resolved to a known user (or definitively no user) by the time this
 *   mounts in practice, since the app-wide setup gate above `/one` only
 *   admits the route once auth is settled — so the uid read here is not a
 *   race against auth still loading.
 *
 * Fully skipped under prefers-reduced-motion too — `VaultLockGuard` and
 * `{children}` mount immediately with no overlay at all.
 * ──────────────────────────────────────────────────────────── */

const LAST_UID_KEY = "hushh.one.intro.lastUid.v1";

type Phase = "idle" | "sweep" | "greet1" | "greet2" | "exit";

const SWEEP_DELAY_MS = 0;
const MIST_TO_MARK_MS = 900;
const GREET1_HOLD_MS = 1000;
const GREET2_HOLD_MS = 1000;
const EXIT_DURATION_MS = 300;
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

// False with no signed-in uid: there is no one to greet yet, and this is
// exactly the case of a logged-out visitor about to be redirected to
// /login by OneAuthGate below — the intro must never play in front of
// that redirect, only after a real login, before the vault. With a uid,
// true unless the intro already played for that exact uid — i.e. true on
// a real first-ever run for this browser, true again for a different uid
// (a genuinely fresh login: sign-out/sign-in, or a different account).
// Fails open toward "play it" on any storage error (private browsing,
// storage disabled) once a uid is known — worst case there is a replay,
// never a silent permanent skip for a real signed-in user.
function shouldPlayIntro(uid: string | null): boolean {
  if (!uid) return false;
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(LAST_UID_KEY) !== uid;
  } catch {
    return true;
  }
}

function markIntroShown(uid: string | null): void {
  if (typeof window === "undefined" || !uid) return;
  try {
    window.localStorage.setItem(LAST_UID_KEY, uid);
  } catch {
    // Nothing to fall back to; the next mount will just decide fresh.
  }
}

export function HushhIntroGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [introComplete, setIntroComplete] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const firedRef = useRef(false);

  useEffect(() => {
    const uid = user?.uid ?? null;
    if (prefersReducedMotion() || !shouldPlayIntro(uid)) {
      setIntroComplete(true);
      return;
    }

    markIntroShown(uid);

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
    // whole sequence. Deliberately NOT depending on `user`: `uid` above is
    // read once, at the moment this decides whether to play at all; the
    // greeting text reads `user` fresh at render time below instead, but
    // the timers themselves must never restart just because auth/setup
    // state changes underneath after this has already started playing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
