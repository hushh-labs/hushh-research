"use client";

import { ArrowRight, Shield, Target, TrendingUp, type LucideIcon } from "lucide-react";

import type { RiskProfile } from "@/lib/services/kai-profile-service";
import { Button } from "@/lib/morphy-ux/button";
import { Icon } from "@/lib/morphy-ux/ui";

const PERSONA_CONFIG: Record<
  RiskProfile,
  {
    pill: string;
    title: string;
    headline: string;
    support: string;
    footerTagline: string;
    icon: LucideIcon;
  }
> = {
  conservative: {
    pill: "YOU VALUE STABILITY",
    title: "Ready for steady growth?",
    headline: "You prefer steady progress without unnecessary swings",
    support: "Kai helps you grow steadily - without exposing you to unnecessary risk",
    footerTagline: "Smart growth. Less stress.",
    icon: Shield,
  },
  balanced: {
    pill: "YOU PLAY IT SMART",
    title: "Ready to move ahead?",
    headline: "You're comfortable with some ups and downs for consistent long-term growth",
    support: "Kai balances opportunity and discipline to keep your growth on track",
    footerTagline: "Progress - without overexposure",
    icon: Target,
  },
  aggressive: {
    pill: "YOU'RE BUILT FOR GROWTH",
    title: "Ready to level up?",
    headline: "You're comfortable with market swings when the potential reward justifies it.",
    support: "Kai helps you pursue stronger growth while managing risk intelligently",
    footerTagline: "Let's build momentum",
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
      className="min-h-[100dvh] w-full bg-transparent flex flex-col px-8 pt-[var(--app-fullscreen-flow-content-offset)] pb-[var(--app-screen-footer-pad)]"
    >
      <div className="w-full max-w-md mx-auto flex-1 min-h-0 flex items-start sm:items-center">
        <section className="relative w-full py-4">
          <div className="relative z-10 space-y-6 text-left">
            <div className="h-20 w-20 rounded-[24px] border border-border/60 bg-background/70 backdrop-blur-sm grid place-items-center shadow-sm">
              <Icon icon={icon} size={40} className="text-[var(--brand-600)]" />
            </div>

            <div className="space-y-3">
              <p className="text-[13px] font-extrabold tracking-[0.2em] text-[var(--brand-600)] uppercase leading-tight">
                {cfg.pill}
              </p>
              <h1 className="text-[clamp(2rem,9.5vw,2.75rem)] font-bold tracking-tight leading-[1.05] text-foreground">
                {cfg.title}
              </h1>
            </div>

            <p className="text-[16px] font-medium leading-relaxed text-muted-foreground">
              {cfg.support}
            </p>

            <p className="text-[21px] font-semibold leading-relaxed text-foreground">
              {cfg.headline}
            </p>

            <p className="text-[16px] font-medium leading-relaxed text-muted-foreground">
              {cfg.footerTagline}
            </p>

            <Button size="lg" fullWidth onClick={props.onLaunchDashboard} showRipple>
              Open Portfolio
              <ArrowRight className="ml-2 h-5 w-5" />
            </Button>

            {props.onEditAnswers && (
              <div className="pt-1">
                <Button
                  variant="blue-gradient"
                  effect="fade"
                  size="lg"
                  fullWidth
                  onClick={props.onEditAnswers}
                  showRipple={false}
                >
                  Edit answers
                </Button>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
