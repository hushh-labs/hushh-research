"use client";

import { ArrowRight, Shield, Target, TrendingUp, type LucideIcon } from "lucide-react";

import type { RiskProfile } from "@/lib/services/kai-profile-service";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";
import {
  kaiAppBodyClassName,
  kaiAppDisplayTitleClassName,
} from "@/components/kai/shared/kai-typography";

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
    pill: "Balanced growth",
    title: "You like progress with discipline.",
    headline: "You can accept some movement when the long-term path is clear.",
    support: "Kai will balance opportunity, concentration, and timing before suggesting action.",
    footerTagline: "Progress without overexposure.",
    accent: "text-primary bg-primary/10 dark:text-blue-300 dark:bg-blue-400/12",
    icon: Target,
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
}) {
  const cfg = PERSONA_CONFIG[props.riskProfile];
  const icon = cfg.icon;

  return (
    <main
      data-top-content-anchor="true"
      className="flex min-h-[100dvh] w-full flex-col bg-transparent px-5 pt-[var(--top-content-pad)] pb-[var(--app-screen-footer-pad)] sm:px-6 lg:px-[var(--page-inline-gutter-standard)]"
    >
      <div className="mx-auto flex min-h-[calc(100dvh-var(--top-content-pad)-var(--app-screen-footer-pad))] w-full max-w-[42rem] flex-1 items-center">
        <section className="w-full rounded-[32px] border border-black/[0.06] bg-white/[0.74] p-5 text-center shadow-[0_24px_80px_-56px_rgba(0,0,0,0.55)] backdrop-blur-2xl sm:p-7 lg:p-8 dark:border-white/10 dark:bg-white/[0.07]">
          <div className="mx-auto flex w-full max-w-[33rem] flex-col items-center">
            <div
              className={`grid h-14 w-14 place-items-center rounded-[18px] ${cfg.accent}`}
              aria-hidden="true"
            >
              <Icon icon={icon} size={28} />
            </div>

            <div className="mt-5 space-y-3">
              <p className="text-[12px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                {cfg.pill}
              </p>
              <h1 className={`text-balance ${kaiAppDisplayTitleClassName} text-foreground`}>
                {cfg.title}
              </h1>
              <p className={`mx-auto max-w-[30rem] ${kaiAppBodyClassName} text-muted-foreground`}>
                {cfg.support}
              </p>
            </div>

            <div className="mt-7 w-full rounded-[24px] border border-black/[0.06] bg-background/72 px-5 py-5 text-left shadow-[0_18px_48px_-42px_rgba(0,0,0,0.65)] dark:border-white/10 dark:bg-white/[0.05]">
              <p className="text-[13px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                Kai profile
              </p>
              <p className="mt-2 text-[18px] font-medium leading-[1.45] text-foreground sm:text-[19px]">
                {cfg.headline}
              </p>
              <p className="mt-3 text-[15px] leading-[1.45] text-muted-foreground">
                {cfg.footerTagline}
              </p>
            </div>

            <div className="mt-7 w-full space-y-3">
              <Button
                type="button"
                size="lg"
                fullWidth
                onClick={props.onLaunchDashboard}
                showRipple
                className="h-11 rounded-full text-[15px] font-semibold shadow-[0_16px_34px_-24px_rgba(0,113,227,0.85)]"
              >
                Connect portfolio
                <ArrowRight className="ml-2 h-5 w-5" aria-hidden="true" />
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
                  className="h-11 rounded-full !bg-primary/10 text-[15px] font-semibold !text-primary shadow-none hover:!bg-primary/15 dark:!bg-primary/15"
                >
                  Edit answers
                </Button>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
