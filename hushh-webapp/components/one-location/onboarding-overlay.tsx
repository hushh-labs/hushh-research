"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Eye,
  KeyRound,
  Lock,
  MapPin,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
  UsersRound,
  X,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────────────────

type SlideKey =
  | "welcome"
  | "kai_circle"
  | "how_it_works"
  | "privacy"
  | "ready";

interface Slide {
  key: SlideKey;
  render: (props: { active: boolean }) => React.ReactNode;
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function GlowDot({ color }: { color: string }) {
  return (
    <span
      className="inline-block h-2.5 w-2.5 rounded-full"
      style={{
        background: color,
        boxShadow: `0 0 8px 2px ${color}55`,
      }}
      aria-hidden="true"
    />
  );
}

function FeatureRow({
  icon: Icon,
  title,
  description,
  tone,
  delay = 0,
  visible,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  tone: "blue" | "green" | "orange" | "purple";
  delay?: number;
  visible: boolean;
}) {
  const toneMap = {
    blue: {
      bg: "bg-[#eaf3ff] dark:bg-[#0a84ff]/15",
      text: "text-[#007aff] dark:text-[#76b7ff]",
    },
    green: {
      bg: "bg-[#eaf9ef] dark:bg-emerald-400/15",
      text: "text-[#2dbd5a] dark:text-emerald-200",
    },
    orange: {
      bg: "bg-[#fff3e6] dark:bg-orange-400/15",
      text: "text-[#ff9500] dark:text-orange-200",
    },
    purple: {
      bg: "bg-[#f0eaff] dark:bg-violet-400/15",
      text: "text-[#8b5cf6] dark:text-violet-300",
    },
  };
  const { bg, text } = toneMap[tone];

  return (
    <div
      className="flex items-start gap-4 transition-all duration-500"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(14px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      <span
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl",
          bg,
          text,
        )}
      >
        <Icon className="h-5 w-5" aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-[15px] font-bold tracking-tight text-[#1c1c1e] dark:text-white">
          {title}
        </p>
        <p className="mt-0.5 text-[13px] leading-[1.5] text-[#8e8e93] dark:text-white/55">
          {description}
        </p>
      </div>
    </div>
  );
}

function TierBadge({
  label,
  color,
  description,
  delay,
  visible,
}: {
  label: string;
  color: string;
  description: string;
  delay: number;
  visible: boolean;
}) {
  return (
    <div
      className="flex items-start gap-3 rounded-[16px] border border-black/[0.05] bg-white p-3 shadow-sm dark:border-white/[0.07] dark:bg-white/[0.06] transition-all duration-500"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? "translateY(0)" : "translateY(12px)",
        transitionDelay: `${delay}ms`,
      }}
    >
      <GlowDot color={color} />
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-[13px] font-bold text-[#1c1c1e] dark:text-white">
          {label}
        </p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[#8e8e93] dark:text-white/50">
          {description}
        </p>
      </div>
    </div>
  );
}

// ─── Step 1: Welcome ─────────────────────────────────────────────────────────

function WelcomeSlide({ active }: { active: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-6 py-8">
      {/* Hero icon cluster */}
      <div
        className="relative mb-8 flex items-center justify-center transition-all duration-700"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "scale(1)" : "scale(0.85)",
        }}
      >
        {/* Outer glow ring */}
        <div className="absolute h-36 w-36 rounded-full bg-gradient-to-br from-[#007aff]/20 to-[#5856d6]/20 blur-2xl" />
        {/* Main circle */}
        <div className="relative flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-br from-[#007aff] to-[#5856d6] shadow-[0_12px_40px_rgba(0,122,255,0.45)]">
          <MapPin className="h-12 w-12 text-white" aria-hidden="true" />
        </div>
        {/* Orbiting icons */}
        <span className="absolute -right-3 -top-3 flex h-10 w-10 items-center justify-center rounded-full bg-[#eaf9ef] shadow-md dark:bg-emerald-400/20">
          <ShieldCheck className="h-5 w-5 text-[#2dbd5a]" aria-hidden="true" />
        </span>
        <span className="absolute -bottom-2 -left-4 flex h-9 w-9 items-center justify-center rounded-full bg-[#fff3e6] shadow-md dark:bg-orange-400/20">
          <KeyRound className="h-4 w-4 text-[#ff9500]" aria-hidden="true" />
        </span>
        <span className="absolute -bottom-1 right-0 flex h-8 w-8 items-center justify-center rounded-full bg-[#f0eaff] shadow-md dark:bg-violet-400/20">
          <UsersRound className="h-4 w-4 text-[#8b5cf6]" aria-hidden="true" />
        </span>
      </div>

      {/* Text */}
      <div
        className="space-y-3 transition-all duration-700"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "translateY(0)" : "translateY(16px)",
          transitionDelay: "100ms",
        }}
      >
        <span className="inline-block rounded-full bg-[#007aff]/10 px-3.5 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
          One Location
        </span>
        <h2 className="text-[32px] font-black leading-[1.1] tracking-tight text-[#1c1c1e] dark:text-white sm:text-[36px]">
          Your circle,
          <br />
          <span
            style={{
              background:
                "linear-gradient(135deg, #007aff 0%, #5856d6 100%)",
              WebkitBackgroundClip: "text",
              WebkitTextFillColor: "transparent",
              backgroundClip: "text",
            }}
          >
            safely connected.
          </span>
        </h2>
        <p className="mx-auto max-w-[300px] text-[16px] leading-relaxed text-[#8e8e93] dark:text-white/55">
          Share your real-time location with people you trust — privately, with
          end-to-end encryption and your full control.
        </p>
      </div>

      {/* Pulse ring animation */}
      <div
        className="mt-8 flex items-center gap-2 transition-all duration-500"
        style={{
          opacity: active ? 1 : 0,
          transitionDelay: "300ms",
        }}
      >
        <span className="relative flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#007aff] opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[#007aff]" />
        </span>
        <span className="text-[13px] font-semibold text-[#007aff] dark:text-[#76b7ff]">
          Always encrypted · Always yours
        </span>
      </div>
    </div>
  );
}

// ─── Step 2: KAI Circle ──────────────────────────────────────────────────────

function KaiCircleSlide({ active }: { active: boolean }) {
  return (
    <div className="flex h-full flex-col px-6 py-8">
      <div
        className="mb-6 transition-all duration-500"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "translateY(0)" : "translateY(12px)",
        }}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#007aff]/10 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
          <Sparkles className="h-3 w-3" aria-hidden="true" />
          KAI Circle
        </span>
        <h2 className="mt-2 text-[26px] font-black leading-[1.2] tracking-tight text-[#1c1c1e] dark:text-white sm:text-[30px]">
          Smart trust-ranked
          <br />
          recommendations
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[#8e8e93] dark:text-white/55">
          KAI automatically surfaces the right people based on your
          relationship, trust history, and professional signals.
        </p>
      </div>

      {/* Tier cards */}
      <div className="flex-1 space-y-2.5 overflow-y-auto">
        <TierBadge
          label="Needs Action"
          color="#ff9500"
          description="Pending requests and approvals waiting on your decision right now."
          delay={80}
          visible={active}
        />
        <TierBadge
          label="Trusted Circle"
          color="#2dbd5a"
          description="People with active shares, repeat approvals, or referrals from your network."
          delay={160}
          visible={active}
        />
        <TierBadge
          label="Professional Network"
          color="#007aff"
          description="RIAs, advisors, investors, and marketplace signals from your KAI profile."
          delay={240}
          visible={active}
        />
        <TierBadge
          label="Location-Ready Members"
          color="#5856d6"
          description="Verified KAI members who've set up encrypted location keys — ready to share."
          delay={320}
          visible={active}
        />
        <TierBadge
          label="Needs Setup"
          color="#8e8e93"
          description="People who just need to open One Location once to enable receiving."
          delay={400}
          visible={active}
        />
      </div>
    </div>
  );
}

// ─── Step 3: How It Works ────────────────────────────────────────────────────

function HowItWorksSlide({ active }: { active: boolean }) {
  return (
    <div className="flex h-full flex-col px-6 py-8">
      <div
        className="mb-6 transition-all duration-500"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "translateY(0)" : "translateY(12px)",
        }}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eaf3ff] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
          <Zap className="h-3 w-3" aria-hidden="true" />
          How it works
        </span>
        <h2 className="mt-2 text-[26px] font-black leading-[1.2] tracking-tight text-[#1c1c1e] dark:text-white sm:text-[30px]">
          Share or request
          <br />
          in seconds
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[#8e8e93] dark:text-white/55">
          Two simple workflows — you always stay in control of who sees what.
        </p>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto">
        {/* Share flow */}
        <div
          className="overflow-hidden rounded-[18px] border border-black/[0.05] bg-gradient-to-br from-[#eaf9ef] to-white p-4 dark:border-white/[0.07] dark:from-emerald-400/10 dark:to-transparent transition-all duration-500"
          style={{
            opacity: active ? 1 : 0,
            transform: active ? "translateY(0)" : "translateY(10px)",
            transitionDelay: "80ms",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#2dbd5a] text-white shadow-sm">
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <p className="font-bold text-[15px] text-[#1c1c1e] dark:text-white">Share your location</p>
          </div>
          <ol className="space-y-1.5 pl-1">
            {[
              "Select KAI Circle members",
              "Choose a sharing duration (15 min → 24 hrs)",
              "Confirm — your live location is encrypted",
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-[#3a3a3c] dark:text-white/70">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#2dbd5a]/20 text-[10px] font-bold text-[#2dbd5a]">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        {/* Request flow */}
        <div
          className="overflow-hidden rounded-[18px] border border-black/[0.05] bg-gradient-to-br from-[#eaf3ff] to-white p-4 dark:border-white/[0.07] dark:from-[#0a84ff]/10 dark:to-transparent transition-all duration-500"
          style={{
            opacity: active ? 1 : 0,
            transform: active ? "translateY(0)" : "translateY(10px)",
            transitionDelay: "180ms",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#007aff] text-white shadow-sm">
              <UserRoundCheck className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <p className="font-bold text-[15px] text-[#1c1c1e] dark:text-white">Request from someone</p>
          </div>
          <ol className="space-y-1.5 pl-1">
            {[
              "Select who you want to see",
              "Optionally add a reason or message",
              "They approve → you get encrypted access",
            ].map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-[#3a3a3c] dark:text-white/70">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#007aff]/20 text-[10px] font-bold text-[#007aff]">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>

        {/* Public invite */}
        <div
          className="overflow-hidden rounded-[18px] border border-black/[0.05] bg-gradient-to-br from-[#fff3e6] to-white p-4 dark:border-white/[0.07] dark:from-orange-400/10 dark:to-transparent transition-all duration-500"
          style={{
            opacity: active ? 1 : 0,
            transform: active ? "translateY(0)" : "translateY(10px)",
            transitionDelay: "280ms",
          }}
        >
          <div className="flex items-center gap-2 mb-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#ff9500] text-white shadow-sm">
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            <p className="font-bold text-[15px] text-[#1c1c1e] dark:text-white">Public invite link</p>
          </div>
          <p className="text-[13px] text-[#3a3a3c] dark:text-white/70 leading-relaxed">
            Create a shareable link for anyone to send you a request. You still
            approve before any location data is ever shared.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Step 4: Privacy ─────────────────────────────────────────────────────────

function PrivacySlide({ active }: { active: boolean }) {
  return (
    <div className="flex h-full flex-col px-6 py-8">
      <div
        className="mb-6 transition-all duration-500"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "translateY(0)" : "translateY(12px)",
        }}
      >
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#eaf9ef] px-3 py-1 text-[11px] font-bold uppercase tracking-[0.18em] text-[#2dbd5a] dark:bg-emerald-400/15 dark:text-emerald-200">
          <Lock className="h-3 w-3" aria-hidden="true" />
          Privacy-first
        </span>
        <h2 className="mt-2 text-[26px] font-black leading-[1.2] tracking-tight text-[#1c1c1e] dark:text-white sm:text-[30px]">
          Encrypted at every step.
          <br />
          <span className="text-[#2dbd5a]">No compromises.</span>
        </h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[#8e8e93] dark:text-white/55">
          One Location is built on ECDH-P256 + AES-256-GCM encryption. Your
          location is never stored in plaintext on our servers.
        </p>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto">
        <FeatureRow
          icon={KeyRound}
          title="End-to-end encryption"
          description="Each share uses a unique recipient public key. Only they can decrypt your location."
          tone="blue"
          delay={80}
          visible={active}
        />
        <FeatureRow
          icon={ShieldCheck}
          title="You always approve"
          description="No one can see your location without an explicit share or an approval from you."
          tone="green"
          delay={180}
          visible={active}
        />
        <FeatureRow
          icon={CheckCircle2}
          title="Automatic expiry"
          description="Every share has a time limit — 15 min, 1 hr, 24 hrs. It expires automatically."
          tone="orange"
          delay={280}
          visible={active}
        />
        <FeatureRow
          icon={UsersRound}
          title="Contact scan stays on-device"
          description="Contact matching uses private hashed lookups — your contact list never leaves your device."
          tone="purple"
          delay={380}
          visible={active}
        />
      </div>
    </div>
  );
}

// ─── Step 5: Ready ───────────────────────────────────────────────────────────

function ReadySlide({ active }: { active: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-center px-6 py-8">
      <div
        className="relative mb-8 transition-all duration-700"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "scale(1) rotate(0deg)" : "scale(0.7) rotate(-10deg)",
        }}
      >
        <div className="absolute inset-0 rounded-full bg-gradient-to-br from-[#2dbd5a]/30 to-[#007aff]/30 blur-2xl" />
        <div className="relative flex h-24 w-24 items-center justify-center rounded-full bg-gradient-to-br from-[#2dbd5a] to-[#007aff] shadow-[0_12px_40px_rgba(45,189,90,0.4)]">
          <CheckCircle2 className="h-11 w-11 text-white" aria-hidden="true" />
        </div>
      </div>

      <div
        className="space-y-3 transition-all duration-700"
        style={{
          opacity: active ? 1 : 0,
          transform: active ? "translateY(0)" : "translateY(16px)",
          transitionDelay: "150ms",
        }}
      >
        <h2 className="text-[30px] font-black leading-[1.1] tracking-tight text-[#1c1c1e] dark:text-white sm:text-[34px]">
          You're all set!
        </h2>
        <p className="mx-auto max-w-[300px] text-[15px] leading-relaxed text-[#8e8e93] dark:text-white/55">
          Your KAI Circle is ready to connect. Share selectively, approve
          thoughtfully, and stay in control — always.
        </p>
      </div>

      {/* Checklist */}
      <div
        className="mt-8 w-full max-w-[320px] space-y-2.5 transition-all duration-500"
        style={{
          opacity: active ? 1 : 0,
          transitionDelay: "300ms",
        }}
      >
        {[
          "KAI Circle recommendations active",
          "End-to-end encryption enabled",
          "Location sharing ready",
        ].map((item, i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-[14px] border border-black/[0.04] bg-[#f7f7fa] px-4 py-3 dark:border-white/[0.07] dark:bg-white/[0.06]"
          >
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#2dbd5a]" aria-hidden="true" />
            <span className="text-[13px] font-semibold text-[#1c1c1e] dark:text-white">
              {item}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Dots indicator ──────────────────────────────────────────────────────────

function SlideDots({
  count,
  active,
  onDotClick,
}: {
  count: number;
  active: number;
  onDotClick: (index: number) => void;
}) {
  return (
    <div className="flex items-center justify-center gap-2" aria-label="Slide navigation">
      {Array.from({ length: count }).map((_, i) => (
        <button
          key={i}
          type="button"
          onClick={() => onDotClick(i)}
          aria-label={`Go to slide ${i + 1}`}
          aria-current={i === active ? "step" : undefined}
          className={cn(
            "rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#007aff]",
            i === active
              ? "h-2.5 w-7 bg-[#007aff]"
              : "h-2.5 w-2.5 bg-[#007aff]/25 hover:bg-[#007aff]/40",
          )}
        />
      ))}
    </div>
  );
}

// ─── Main Overlay ─────────────────────────────────────────────────────────────

const SLIDES: Slide[] = [
  { key: "welcome", render: ({ active }) => <WelcomeSlide active={active} /> },
  { key: "kai_circle", render: ({ active }) => <KaiCircleSlide active={active} /> },
  { key: "how_it_works", render: ({ active }) => <HowItWorksSlide active={active} /> },
  { key: "privacy", render: ({ active }) => <PrivacySlide active={active} /> },
  { key: "ready", render: ({ active }) => <ReadySlide active={active} /> },
];

let onboardingSeenThisSession = false;

function getOnboardingSeen(): boolean {
  return onboardingSeenThisSession;
}

function setOnboardingSeen(): void {
  onboardingSeenThisSession = true;
}

export function OneLocationOnboardingOverlay({
  onDismiss,
}: {
  onDismiss: () => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [exiting, setExiting] = useState(false);
  const [mounted, setMounted] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isLast = currentIndex === SLIDES.length - 1;

  // Entrance animation
  useEffect(() => {
    const id = window.setTimeout(() => setMounted(true), 30);
    return () => window.clearTimeout(id);
  }, []);

  const handleDismiss = () => {
    setExiting(true);
    setOnboardingSeen();
    window.setTimeout(() => onDismiss(), 350);
  };

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown") {
        setCurrentIndex((prev) => Math.min(prev + 1, SLIDES.length - 1));
      } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
        setCurrentIndex((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Escape") {
        setExiting(true);
        setOnboardingSeen();
        window.setTimeout(() => onDismiss(), 350);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const handleNext = () => {
    if (isLast) {
      handleDismiss();
    } else {
      setCurrentIndex((prev) => prev + 1);
    }
  };

  const handlePrev = () => {
    setCurrentIndex((prev) => Math.max(prev - 1, 0));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="One Location feature introduction"
      ref={containerRef}
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      style={{
        transition: "opacity 350ms ease, backdrop-filter 350ms ease",
        opacity: mounted && !exiting ? 1 : 0,
        backdropFilter: mounted && !exiting ? "blur(12px)" : "blur(0px)",
        backgroundColor:
          mounted && !exiting ? "rgba(0,0,0,0.55)" : "rgba(0,0,0,0)",
      }}
    >
      {/* Panel */}
      <div
        className="relative flex w-full flex-col overflow-hidden rounded-t-[28px] bg-white shadow-[0_-8px_60px_rgba(0,0,0,0.22)] sm:max-w-[420px] sm:rounded-[28px] dark:bg-[#1c1c1e]"
        style={{
          height: "min(660px, 92dvh)",
          transition: "transform 350ms cubic-bezier(0.34, 1.56, 0.64, 1), opacity 350ms ease",
          transform: mounted && !exiting ? "translateY(0)" : "translateY(40px)",
          opacity: mounted && !exiting ? 1 : 0,
        }}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-5 pt-5 pb-1 shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-[#007aff] to-[#5856d6]">
              <MapPin className="h-3.5 w-3.5 text-white" aria-hidden="true" />
            </div>
            <span className="text-[13px] font-bold text-[#1c1c1e] dark:text-white">
              One Location
            </span>
            <span className="rounded-full bg-[#007aff]/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#007aff] dark:bg-[#0a84ff]/15 dark:text-[#76b7ff]">
              Intro
            </span>
          </div>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Skip introduction"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f2f2f7] text-[#8e8e93] transition-colors hover:bg-[#e5e5ea] dark:bg-white/10 dark:text-white/55 dark:hover:bg-white/15"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {/* Slide container */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {SLIDES.map((slide, i) => (
            <div
              key={slide.key}
              className="absolute inset-0 overflow-y-auto"
              aria-hidden={i !== currentIndex}
              style={{
                transition: "opacity 350ms ease, transform 350ms cubic-bezier(0.4, 0, 0.2, 1)",
                opacity: i === currentIndex ? 1 : 0,
                transform:
                  i === currentIndex
                    ? "translateX(0)"
                    : i < currentIndex
                      ? "translateX(-24px)"
                      : "translateX(24px)",
                pointerEvents: i === currentIndex ? "auto" : "none",
                zIndex: i === currentIndex ? 1 : 0,
              }}
            >
              {slide.render({ active: i === currentIndex })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div className="shrink-0 space-y-4 border-t border-black/[0.05] px-5 py-4 dark:border-white/[0.07]">
          <SlideDots
            count={SLIDES.length}
            active={currentIndex}
            onDotClick={setCurrentIndex}
          />

          <div className="flex items-center gap-3">
            {currentIndex > 0 && (
              <button
                type="button"
                onClick={handlePrev}
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[16px] border border-black/[0.06] bg-[#f2f2f7] text-[#1c1c1e] transition-colors hover:bg-[#e5e5ea] dark:border-white/[0.08] dark:bg-white/10 dark:text-white dark:hover:bg-white/15"
                aria-label="Previous slide"
              >
                <ChevronRight className="h-5 w-5 rotate-180" aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              id="one-location-onboarding-next"
              onClick={handleNext}
              className="flex h-12 flex-1 items-center justify-center gap-2 rounded-[16px] bg-gradient-to-b from-[#1a85ff] to-[#0066ff] text-[15px] font-bold text-white shadow-[0_4px_14px_rgba(0,122,255,0.35)] transition-opacity hover:opacity-95 active:opacity-90"
            >
              {isLast ? (
                <>
                  <CheckCircle2 className="h-4.5 w-4.5" aria-hidden="true" />
                  Get started
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="h-4.5 w-4.5" aria-hidden="true" />
                </>
              )}
            </button>
          </div>

          {!isLast && (
            <p className="text-center text-[12px] text-[#8e8e93] dark:text-white/40">
              {currentIndex + 1} of {SLIDES.length} — tap anywhere to continue
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns whether the onboarding overlay should be shown for the first time.
 * Keeps the "seen" state in memory for the current app session.
 */
export function useOneLocationOnboarding() {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    // Small delay so the main page renders first, then auto-show on first visit
    const id = window.setTimeout(() => {
      if (!getOnboardingSeen()) {
        setShouldShow(true);
      }
    }, 600);
    return () => window.clearTimeout(id);
  }, []);

  const dismiss = () => {
    setOnboardingSeen();
    setShouldShow(false);
  };

  /** Manually re-trigger the tour (even if already seen). */
  const showTour = () => {
    setShouldShow(true);
  };

  return { shouldShow, dismiss, showTour };
}
