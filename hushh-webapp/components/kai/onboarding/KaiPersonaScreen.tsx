"use client";

import { Shield, TrendingUp, LineChart, type LucideIcon } from "lucide-react";

import type { RiskProfile } from "@/lib/services/kai-profile-service";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import { cn } from "@/lib/utils";

const PERSONA_CONFIG: Record<
  RiskProfile,
  {
    pill: string;
    title: string;
    headline: string;
    support: string;
    footerTagline: string;
    accent: string;
    icon: LucideIcon;
  }
> = {
  conservative: {
    pill: "Stability first",
    title: "Your plan should feel steady.",
    headline: "You prefer dependable progress with fewer surprises.",
    support: "Kai will keep risk visible, pacing calm, and every move easy to understand.",
    footerTagline: "Smart growth. Less stress.",
    accent: "text-emerald-600 bg-emerald-500/10 dark:text-emerald-300 dark:bg-emerald-400/12",
    icon: Shield,
  },
  balanced: {
    pill: "Stability first",
    title: "You like progress with discipline.",
    headline: "You can accept some movement when the long-term path is clear.",
    support: "Kai will balance opportunity, concentration, and timing before suggesting action.",
    footerTagline: "Progress without overexposure.",
    accent: "text-blue-600 bg-blue-500/10 dark:text-blue-400 dark:bg-blue-400/12",
    icon: LineChart,
  },
  aggressive: {
    pill: "Growth focused",
    title: "You are comfortable leaning in.",
    headline: "You can handle larger swings when the upside is worth the risk.",
    support: "Kai will help you pursue momentum while keeping downside and concentration in view.",
    footerTagline: "Build momentum with guardrails.",
    accent: "text-orange-600 bg-orange-500/10 dark:text-orange-300 dark:bg-orange-400/12",
    icon: TrendingUp,
  },
};

export function KaiPersonaScreen(props: {
  riskProfile: RiskProfile;
  onLaunchDashboard: () => void;
  onEditAnswers?: () => void;
  terminalFooter?: React.ReactNode;
}) {
  const cfg = PERSONA_CONFIG[props.riskProfile];
  const icon = cfg.icon;

  return (
    <main
      data-top-content-anchor="true"
      className="flex min-h-[100dvh] w-full flex-col bg-transparent px-5 pt-[var(--top-content-pad)] pb-[var(--app-screen-footer-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
    >
      <div className="mx-auto flex min-h-[calc(100dvh-var(--top-content-pad)-var(--app-screen-footer-pad))] w-full max-w-[25rem] flex-1 flex-col justify-between py-2 sm:py-4">
        <section className="my-auto w-full text-center">
          <div className="mx-auto flex w-full flex-col items-center">
            <div
              className={`grid h-[52px] w-[52px] place-items-center rounded-[17px] ${cfg.accent}`}
              aria-hidden="true"
            >
              <Icon icon={icon} size={26} />
            </div>

            <div className="mt-4 flex flex-col items-center text-center">
              <span className="type-caption text-muted-foreground">
                {cfg.pill}
              </span>
              <h1 className="mt-3 text-balance text-2xl font-bold tracking-tight text-foreground sm:text-3xl leading-snug">
                {cfg.title}
              </h1>
              <p className="mt-4 max-w-[22rem] text-sm leading-relaxed text-muted-foreground text-balance">
                {cfg.support}
              </p>
            </div>

            <div className="mt-7 w-full space-y-3">
              <Button
                type="button"
                variant="none"
                effect="fill"
                size="lg"
                fullWidth
                onClick={props.onLaunchDashboard}
                showRipple
                className={cn(
                  "h-11 rounded-full type-headline",
                  "!bg-primary !text-primary-foreground hover:!bg-primary/90",
                  "transition-transform duration-[var(--motion-duration-sm)] ease-[var(--motion-ease-standard)]",
                  "active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
                )}
              >
                Continue finance setup
              </Button>

              {props.onEditAnswers && (
                <Button
                  type="button"
                  variant="none"
                  effect="fade"
                  size="lg"
                  fullWidth
                  onClick={props.onEditAnswers}
                  showRipple={false}
                  className="h-11 rounded-full !bg-primary/10 type-headline !text-primary shadow-none hover:!bg-primary/15 dark:!bg-primary/15"
                >
                  Edit answers
                </Button>
              )}
            </div>
          </div>
        </section>
        {props.terminalFooter ? (
          <div className="w-full shrink-0">{props.terminalFooter}</div>
        ) : null}
      </div>
    </main>
  );
}
