"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CarouselApi } from "@/components/ui/carousel";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
} from "@/components/ui/carousel";
import { Button } from "@/lib/morphy-ux/button";
import { cn } from "@/lib/utils";
import { OnboardingLocalService } from "@/lib/services/onboarding-local-service";
import { ChevronRight } from "lucide-react";
import { Icon } from "@/lib/morphy-ux/ui";
import { prefersReducedMotion, getGsap } from "@/lib/morphy-ux/gsap";
import { ensureMorphyGsapReady, getMorphyEaseName } from "@/lib/morphy-ux/gsap-init";
import { getMotionCssVars } from "@/lib/morphy-ux/motion";
import { KAI_EXPERIENCE_CONTRACT } from "@/lib/kai/experience-contract";

import { KycPreviewCompact } from "@/components/onboarding/previews/KycPreviewCompact";
import { PortfolioPreviewCompact } from "@/components/onboarding/previews/PortfolioPreviewCompact";
import { DecisionPreviewCompact } from "@/components/onboarding/previews/DecisionPreviewCompact";

type Slide = {
  title: string;
  accent: string;
  subtitle: string;
  preview: React.ReactNode;
};

export function PreviewCarouselStep({ onContinue }: { onContinue: () => void }) {
  const slides: Slide[] = useMemo(
    () => [
      {
        title: "Verified without",
        accent: "friction",
        subtitle:
          "Secure identity verification — fully compliant and completed in minutes.",
        preview: <KycPreviewCompact />,
      },
      {
        title: KAI_EXPERIENCE_CONTRACT.portfolioClarity.carouselTitle,
        accent: KAI_EXPERIENCE_CONTRACT.portfolioClarity.carouselAccent,
        subtitle: "Performance, allocation, and risk — organized in one place.",
        preview: <PortfolioPreviewCompact />,
      },
      {
        title: KAI_EXPERIENCE_CONTRACT.decisionConviction.carouselTitle,
        accent: KAI_EXPERIENCE_CONTRACT.decisionConviction.carouselAccent,
        subtitle:
          "Every decision is backed by structured analysis and aligned to your risk profile.",
        preview: <DecisionPreviewCompact />,
      },
    ],
    []
  );

  const [api, setApi] = useState<CarouselApi | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [displayIndex, setDisplayIndex] = useState(0);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!api) return;

    const sync = () => {
      setSelectedIndex(api.selectedScrollSnap());
    };
    sync();
    api.on("select", sync);
    api.on("reInit", sync);

    return () => {
      api.off("select", sync);
      api.off("reInit", sync);
    };
  }, [api]);

  const isLast = selectedIndex === slides.length - 1;

  // Step entrance animation: this is what you feel when clicking "Get Started"
  // and transitioning from Step 1 -> Step 2 without a route change.
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    if (prefersReducedMotion()) return;

    let cancelled = false;
    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;
      const { pageEnterDurationMs } = getMotionCssVars();
      gsap.fromTo(
        el,
        { opacity: 0, y: 10 },
        {
          opacity: 1,
          y: 0,
          duration: pageEnterDurationMs / 1000,
          ease: getMorphyEaseName("emphasized"),
          overwrite: "auto",
          clearProps: "opacity,transform",
        }
      );
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Animate header text changes to avoid a jump-cut when the slide index changes.
  // We fade out the old copy, swap the index, then fade in.
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;

    if (prefersReducedMotion()) {
      setDisplayIndex(selectedIndex);
      return;
    }

    let cancelled = false;

    void (async () => {
      await ensureMorphyGsapReady();
      const gsap = await getGsap();
      if (!gsap || cancelled) return;
      const { durationsMs } = getMotionCssVars();
      gsap.to(el, {
        opacity: 0,
        y: -4,
        duration: durationsMs.sm / 1000,
        ease: getMorphyEaseName("decelerate"),
        overwrite: "auto",
        onComplete: () => {
          if (cancelled) return;
          setDisplayIndex(selectedIndex);
          gsap.fromTo(
            el,
            { opacity: 0, y: 8 },
            {
              opacity: 1,
              y: 0,
              duration: durationsMs.lg / 1000,
              ease: getMorphyEaseName("emphasized"),
              overwrite: "auto",
              clearProps: "opacity,transform",
            }
          );
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedIndex]);

  async function completeAndContinue() {
    await OnboardingLocalService.markMarketingSeen();
    onContinue();
  }

  async function handlePrimary() {
    if (isLast) {
      await completeAndContinue();
      return;
    }
    api?.scrollNext();
  }

  return (
    <main
      ref={mountRef}
      className={cn(
        "min-h-[100dvh] w-full bg-transparent flex flex-col"
      )}
    >
      <div className="w-full min-h-[100dvh] px-4 pt-6 pb-[var(--app-screen-footer-pad)]">
        <div className="relative mx-auto flex h-full w-full flex-col">
          <div className="absolute right-0 top-0 z-10">
            <Button
              variant="blue-gradient"
              effect="fade"
              size="default"
              showRipple
              onClick={completeAndContinue}
            >
              Skip
              <Icon icon={ChevronRight} size="sm" className="ml-1" />
            </Button>
          </div>

          <div
            ref={headerRef}
            className={cn(
              "w-full mx-auto text-center flex flex-col justify-end gap-3",
              // Keep copy + spacing responsive without clipping on larger screens.
              "min-h-[clamp(168px,22vh,248px)] pt-8",
              "sm:max-w-lg"
            )}
          >
            <h2 className="text-[clamp(2rem,5.6vw,3.2rem)] font-black tracking-tight leading-[1.08]">
              {slides[displayIndex]?.title}
              <br />
              <span className="hushh-gradient-text">{slides[displayIndex]?.accent}</span>
            </h2>
            <p className="mx-auto max-w-[19rem] text-[clamp(0.95rem,2.2vw,1.05rem)] text-muted-foreground leading-relaxed">
              {slides[displayIndex]?.subtitle}
            </p>
          </div>

          <div className="min-h-0 flex-1 flex items-center">
            <Carousel
              opts={{ align: "center", containScroll: "trimSnaps" }}
              setApi={setApi}
              className="w-full"
            >
              <CarouselContent className="items-center -ml-0">
                {slides.map((slide, idx) => (
                  <CarouselItem
                    key={idx}
                    className="basis-full pl-0 flex items-center justify-center"
                  >
                    <div className="flex w-full min-h-[clamp(24rem,50vh,31rem)] items-center justify-center px-4 sm:px-6 md:px-8 py-3">
                      <div className="h-[clamp(31rem,58vh,35rem)] w-full max-w-[22rem] sm:max-w-[24rem] md:max-w-[25rem] lg:max-w-[26rem] xl:max-w-[27rem]">
                        {slide.preview}
                      </div>
                    </div>
                  </CarouselItem>
                ))}
              </CarouselContent>
              <CarouselPrevious className="left-2 border border-[var(--morphy-primary-start)]/25 bg-gradient-to-r from-[var(--morphy-primary-start)]/14 to-[var(--morphy-primary-end)]/14 text-[var(--morphy-primary-start)] backdrop-blur-sm transition-colors hover:from-[var(--morphy-primary-start)]/20 hover:to-[var(--morphy-primary-end)]/20 disabled:border-border/60 disabled:bg-muted/70 disabled:text-muted-foreground disabled:opacity-100" />
              <CarouselNext className="right-2 border border-[var(--morphy-primary-start)]/25 bg-gradient-to-r from-[var(--morphy-primary-start)]/14 to-[var(--morphy-primary-end)]/14 text-[var(--morphy-primary-start)] backdrop-blur-sm transition-colors hover:from-[var(--morphy-primary-start)]/20 hover:to-[var(--morphy-primary-end)]/20 disabled:border-border/60 disabled:bg-muted/70 disabled:text-muted-foreground disabled:opacity-100" />
            </Carousel>
          </div>

          <div className="mt-4 flex flex-col justify-end gap-4">
            <Dots count={slides.length} activeIndex={selectedIndex} />

            <Button
              size="lg"
              fullWidth
              className="mx-auto w-full max-w-md"
              onClick={handlePrimary}
              showRipple
            >
              {isLast ? "Continue" : "Next"}
              <Icon icon={ChevronRight} size="md" className="ml-2" />
            </Button>
          </div>
        </div>
      </div>
    </main>
  );
}

function Dots(props: { count: number; activeIndex: number }) {
  return (
    <div className="flex items-center justify-center gap-2">
      {Array.from({ length: props.count }).map((_, i) => (
        <span
          key={i}
          className={cn(
            "h-2 w-2 rounded-full transition-colors",
            i === props.activeIndex
              ? "bg-[var(--morphy-primary-start)]"
              : "bg-[var(--morphy-primary-start)]/20"
          )}
          aria-hidden
        />
      ))}
    </div>
  );
}
