"use client";

import { ArrowRight, CandlestickChart, LogIn, TrendingUp, Zap } from "lucide-react";
import { Button } from "@/lib/morphy-ux/button";
import { BrandMark, Icon, OnboardingFeatureList } from "@/lib/morphy-ux/ui";

export function IntroStep({
  onNext,
  onLogin,
}: {
  onNext: () => void;
  onLogin?: () => void;
}) {
  return (
    <main className="min-h-[100dvh] w-full bg-transparent">
      <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col px-6 pt-8">
        <div className="flex-1 min-h-0">
          <div className="flex min-h-full flex-col items-center text-center">
            <BrandMark size="md" unframed />

            <div className="mt-8 space-y-4">
              <h1 className="text-[clamp(2.25rem,7.5vw,3.2rem)] font-black tracking-tight leading-[1.08]">
                Meet One,
                <br />
                Your Personal
                <br />
                Financial Advisor
              </h1>
              <p className="mx-auto max-w-[18rem] text-[clamp(1rem,3.8vw,1.125rem)] leading-relaxed text-muted-foreground">
                The fastest path to actionable wealth insights.
              </p>
            </div>

            <div className="mt-8 w-full max-w-sm text-left">
              <OnboardingFeatureList
                features={[
                  {
                    tone: "blue",
                    icon: Zap,
                    title: "Seamless KYC",
                    subtitle: "Accelerating KYC with frictionless verification",
                  },
                  {
                    tone: "green",
                    icon: TrendingUp,
                    title: "Portfolio Monitoring",
                    subtitle: "Identify top performing holdings at a glance.",
                  },
                  {
                    tone: "orange",
                    icon: CandlestickChart,
                    title: "Actionable Advice",
                    subtitle:
                      "Giving quick buy, sell, and hold investment signals",
                  },
                ]}
              />
            </div>
          </div>
        </div>

        <footer className="flex-none pt-4 pb-[var(--app-screen-footer-pad)]">
          <div className="space-y-3">
            <Button size="lg" fullWidth onClick={onNext} showRipple>
              Get Started
              <Icon icon={ArrowRight} size="md" className="ml-2" />
            </Button>
            {onLogin ? (
              <Button
                size="lg"
                fullWidth
                variant="none"
                effect="fade"
                className="border border-border/70 bg-background/80"
                onClick={onLogin}
                showRipple
              >
                Login
                <Icon icon={LogIn} size="md" className="ml-2" />
              </Button>
            ) : null}
          </div>
        </footer>
      </div>
    </main>
  );
}
