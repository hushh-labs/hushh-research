"use client";

import Image from "next/image";
import { useEffect, useRef } from "react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { ShellActionSurface } from "@/components/app-ui/shell-action-surface";
import { ArrowLeft, ArrowRight, ShieldCheck } from "@/components/icons";
import { Button } from "@/lib/morphy-ux/button";
import { ROUTES } from "@/lib/navigation/routes";
import { useScrollReset } from "@/lib/navigation/use-scroll-reset";

import styles from "./referral-introduction.module.css";

const STEPS = [
  { title: "Share your One", detail: "Send your personal invite link to your people." },
  { title: "Grow together", detail: "Earn points when eligible friends qualify." },
  { title: "Make it rewarding", detail: "Follow your progress and discover your next reward." },
] as const;

type ReferralIntroductionProps = {
  onContinue: () => void;
  onBack: () => void;
  busy: boolean;
};

/** A cosmetic welcome screen; continuing never changes referral or setup eligibility. */
export function ReferralIntroduction({ onContinue, onBack, busy }: ReferralIntroductionProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  useScrollReset("referral-introduction");

  useEffect(() => {
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className={styles.root} data-referral-introduction="true">
      <NativeTestBeacon
        routeId={ROUTES.ONE_REFERRALS}
        marker="native-route-one-referrals"
        authState="authenticated"
        dataState="loaded"
      />
      <header className={styles.header}>
        <div className={styles.brandGroup}>
          <ShellActionSurface
            aria-label="Back to One home"
            onClick={onBack}
            className={`referral-back-button ${styles.back}`}
          >
            <ArrowLeft aria-hidden="true" className="size-5" />
          </ShellActionSurface>
          <span className={styles.brand}>
            <span className={`referral-reference-mark ${styles.brandMark}`} aria-hidden="true" />
            One<span className={styles.brandDot}>.</span>
          </span>
          <span className={styles.brandByline}>by hushh</span>
        </div>
        <button className={styles.skip} onClick={onContinue} disabled={busy}>
          Skip intro <ArrowRight aria-hidden="true" />
        </button>
      </header>

      <main className={styles.main}>
        <section className={styles.hero} aria-labelledby="referral-welcome-title">
          <div className={styles.phone} aria-hidden="true">
            <span className={styles.phoneCamera} />
            <span className={styles.phoneHome} />
          </div>

          <div className={styles.copy}>
            <p className={styles.eyebrow}><span /> ONE IS BETTER WITH YOUR PEOPLE</p>
            <h1 ref={titleRef} id="referral-welcome-title" className={styles.title} tabIndex={-1}>
              Life’s better.<br /><span>Together.</span>
            </h1>
            <p className={styles.description}>
              Give your people their own private agent.<br className={styles.desktopBreak} />
              {" "}Share One. Grow your circle. Unlock rewards.
            </p>
            <Button
              className={styles.continue}
              onClick={onContinue}
              disabled={busy}
              aria-busy={busy}
            >
              <span className={styles.continueLabel}>
                {busy ? "Opening your dashboard…" : "Go to my dashboard"}
                <ArrowRight aria-hidden="true" className="size-[18px]" />
              </span>
            </Button>
            <p className={styles.reassurance}>
              <ShieldCheck aria-hidden="true" /> Your people. Their choice. Always private.
            </p>
          </div>

          <div className={styles.artwork}>
            <Image
              src="/referrals/referral-onboarding-agents.webp"
              alt="Four people sitting on Hushh’s Calendar, Finance, Mail, and Memory agent tiles."
              width={1536}
              height={1024}
              sizes="(max-width: 600px) 100vw, (max-width: 1024px) 90vw, 900px"
              loading="eager"
              fetchPriority="high"
              className={styles.agents}
            />
          </div>
          <div className={styles.agentCaption} aria-hidden="true">
            <span>Calendar</span><span>Finance</span><span>Mail</span><span>Memory</span>
          </div>
        </section>

        <section className={styles.howItWorks} aria-label="How referrals work">
          <p className={styles.stepsEyebrow}>A LITTLE INVITE. A LOT OF POSSIBILITY.</p>
          <ol className={styles.steps}>
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className={styles.stepNumber} aria-hidden="true">0{index + 1}</span>
                <div>
                  <h2>{step.title}</h2>
                  <p>{step.detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className={styles.footer}>
        <span className="referral-reference-mark" aria-hidden="true" />
        Your agents. Yours to own.
      </footer>
    </div>
  );
}
