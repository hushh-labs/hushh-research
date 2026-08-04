"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { preload } from "react-dom";
import { ArrowLeft, Check, Loader2, MapPin, UserPlus } from "lucide-react";
import { toast } from "sonner";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import type { ConsentNotificationDeliveryMode } from "@/components/consent/notification-provider";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import locationOnboardingContract from "@/lib/onboarding/one-location-onboarding.contract.json";
import type {
  ConnectionSummaryEntry,
  DirectoryPerson,
} from "@/lib/services/connections-service";
import { cn } from "@/lib/utils";

type OnboardingScreen = "welcome" | "features" | "people" | "circle";

const LOCATION_SCREEN_TEST_IDS = Object.fromEntries(
  locationOnboardingContract.screens.map(({ key, testId }) => [key, testId]),
) as Record<OnboardingScreen, string>;

// "permissions" remains accepted for callers restoring the previous contract.
// It now opens the consolidated feature screen, which owns permission requests.
export type OneLocationOnboardingStart = "welcome" | "permissions";

export type ConnectionRequestResult = {
  sentUserIds: string[];
  failedUserIds: string[];
};

type CircleMember = {
  userId: string;
  displayName: string;
  photoUrl: string | null;
  status: "connected" | "pending";
};

type OneLocationOnboardingFlowProps = {
  startAt: OneLocationOnboardingStart;
  currentUserName: string;
  currentUserPhotoUrl?: string | null;
  people: DirectoryPerson[];
  connections: ConnectionSummaryEntry[];
  peopleLoading: boolean;
  peopleError: string | null;
  locationPermission: HushhLocationPermissionState | null;
  notificationDeliveryMode: ConsentNotificationDeliveryMode;
  notificationBusy: boolean;
  locationBusy: boolean;
  nativeTest: React.ComponentProps<typeof NativeTestBeacon>;
  onRetryPeople: () => void;
  onSendConnectionRequests: (
    userIds: string[],
  ) => Promise<ConnectionRequestResult>;
  onRequestLocation: () => Promise<void>;
  onLocationReady: () => Promise<boolean>;
  onRequestNotifications: () => Promise<void>;
  onBack: () => void | Promise<void>;
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  requireLocationToComplete?: boolean;
};

const WELCOME_ORBIT_ITEMS = [
  {
    src: "/one-location/onboarding/orbit-person-1.webp",
    position: "left-[14%] top-[20%]",
    imageClassName: "object-cover",
  },
  {
    src: "/one-location/onboarding/orbit-office.webp",
    position: "right-[8%] top-[10%]",
    imageClassName: "object-contain",
  },
  {
    src: "/one-location/onboarding/orbit-person-2.webp",
    position: "right-[8%] top-[56%]",
    imageClassName: "object-cover",
  },
  {
    src: "/one-location/onboarding/orbit-person-3.webp",
    position: "bottom-[2%] left-[42%]",
    imageClassName: "object-cover",
  },
  {
    src: "/one-location/onboarding/orbit-car.webp",
    position: "bottom-[14%] left-[3%]",
    imageClassName: "object-contain",
  },
] as const;

const ONBOARDING_IMAGE_SOURCES = WELCOME_ORBIT_ITEMS.map(({ src }) => src);

const AVATAR_TONES = [
  { background: "#2f80ed", foreground: "#ffffff" },
  { background: "#a847e8", foreground: "#ffffff" },
  { background: "#0fae9c", foreground: "#ffffff" },
  { background: "#f38a13", foreground: "#ffffff" },
  { background: "#e74747", foreground: "#ffffff" },
  { background: "#7357df", foreground: "#ffffff" },
] as const;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "O";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function safeName(
  value: string | null | undefined,
  fallback = "Someone",
): string {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function avatarTone(seed: string) {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length]!;
}

function Avatar({
  name,
  photoUrl,
  size = "md",
  colorSeed,
}: {
  name: string;
  photoUrl?: string | null;
  size?: "sm" | "md" | "lg";
  colorSeed?: string;
}) {
  const sizeClass =
    size === "lg"
      ? "h-[72px] w-[72px] text-xl"
      : size === "sm"
        ? "h-9 w-9 text-xs"
        : "h-14 w-14 text-sm";
  const tone = avatarTone(colorSeed || name);

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border-[3px] border-white font-bold shadow-[0_8px_22px_rgba(24,57,91,0.18)] dark:border-[#e7edf6]",
        sizeClass,
      )}
      style={
        photoUrl
          ? undefined
          : { backgroundColor: tone.background, color: tone.foreground }
      }
      aria-hidden="true"
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- Directory photos are remote user media.
        <img
          src={photoUrl}
          alt=""
          loading="eager"
          decoding="async"
          className="h-full w-full object-cover"
        />
      ) : (
        initials(name)
      )}
    </span>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
  busy = false,
  inverse = false,
  className,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  inverse?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cn(
        "press-scale flex h-14 w-full items-center justify-center rounded-full px-6 text-[17px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        inverse
          ? "bg-white text-[color:var(--app-accent-deep)] dark:bg-white dark:text-[#07111f]"
          : "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]",
        className,
      )}
    >
      {busy ? (
        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}

function OnboardingSkipButton({
  onClick,
  disabled = false,
  inverse = false,
  floating = false,
}: {
  onClick: () => void;
  disabled?: boolean;
  inverse?: boolean;
  floating?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "min-h-11 rounded-full text-[16px] font-bold disabled:opacity-50",
        floating
          ? "h-11 bg-[#eef1f5] px-5 text-[color:var(--app-accent-deep)] shadow-[0_4px_14px_rgba(26,42,65,0.14)] ring-1 ring-black/[0.06] dark:bg-[#1b222d] dark:text-[color:var(--app-accent-bright)] dark:ring-white/[0.06]"
          : inverse
            ? "text-white"
            : "min-h-11 px-2 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]",
      )}
    >
      Skip
    </button>
  );
}

function OnboardingNavigation({
  onBack,
  onSkip,
  disabled = false,
  inverse = false,
  floating = false,
  busy = false,
  className,
}: {
  onBack: () => void;
  onSkip: () => void;
  disabled?: boolean;
  inverse?: boolean;
  floating?: boolean;
  busy?: boolean;
  className?: string;
}) {
  return (
    <nav
      aria-label="Onboarding"
      className={cn(
        "relative z-40 flex h-14 shrink-0 items-center justify-between",
        className,
      )}
      data-one-onboarding-navigation
    >
      <button
        type="button"
        onClick={onBack}
        disabled={disabled}
        className={cn(
          "press-scale flex h-11 w-11 items-center justify-center rounded-full disabled:opacity-50",
          floating
            ? "bg-[#eef1f5] text-[#59616c] shadow-[0_4px_14px_rgba(26,42,65,0.14)] ring-1 ring-black/[0.06] dark:bg-[#1b222d] dark:text-white dark:ring-white/[0.06]"
            : inverse
              ? "bg-white/15 text-white"
              : "bg-black/[0.05] text-[#1f2b3d] dark:bg-white/[0.08] dark:text-white",
        )}
        aria-label="Go back"
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <ArrowLeft className="h-6 w-6" aria-hidden="true" />
        )}
      </button>
      <OnboardingSkipButton
        inverse={inverse}
        floating={floating}
        onClick={onSkip}
        disabled={disabled}
      />
    </nav>
  );
}

function WelcomeRadar() {
  return (
    <div
      className="relative mx-auto aspect-square w-[min(88vw,48dvh,390px)]"
      aria-hidden="true"
    >
      {["inset-[5%]", "inset-[21%]", "inset-[37%]"].map((position, index) => (
        <span
          key={position}
          data-one-onboarding-motion
          className={cn(
            "absolute rounded-full border border-white/30",
            position,
            index === 0 && "[animation:oneWelcomeRing_3s_ease-in-out_infinite]",
          )}
        />
      ))}
      <span className="absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center">
        <span className="flex h-[70px] w-[70px] items-center justify-center rounded-full border border-white/70 bg-white text-[#087ff5] shadow-[0_12px_32px_rgba(0,61,144,0.22)]">
          <MapPin className="h-7 w-7 fill-current/10" strokeWidth={2.7} />
        </span>
        <span className="-mt-1 rounded-full bg-white px-4 py-0.5 text-[14px] font-bold text-[#087ff5] shadow-[0_5px_14px_rgba(0,61,144,0.18)]">
          You
        </span>
      </span>
      {WELCOME_ORBIT_ITEMS.map((item, index) => (
        <span
          key={item.src}
          data-one-onboarding-motion
          className={cn(
            "absolute z-10 [animation:oneOrbitItemIn_.48s_ease-out_both]",
            item.position,
          )}
          style={{ animationDelay: `${120 + index * 90}ms` }}
        >
          <span className="block h-[66px] w-[66px] overflow-hidden rounded-[18px] border-[3px] border-white bg-white p-0.5 shadow-[0_12px_28px_rgba(0,40,100,0.28)]">
            {/* eslint-disable-next-line @next/next/no-img-element -- Local static art must render in Capacitor static export. */}
            <img
              src={item.src}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className={cn(
                "h-full w-full rounded-[13px]",
                item.imageClassName,
              )}
            />
          </span>
          <span className="absolute -right-1 -top-1 h-[19px] w-[19px] rounded-full border-[3px] border-white bg-[#31c65b]" />
        </span>
      ))}
      <style>{`
        @keyframes oneWelcomeRing { 0%, 100% { opacity: .32; } 50% { opacity: .78; } }
        @keyframes oneOrbitItemIn { from { opacity: 0; transform: translateY(10px) scale(.92); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @media (prefers-reduced-motion: reduce) { [data-one-onboarding-motion] { animation: none !important; } }
      `}</style>
    </div>
  );
}

function WelcomeScreen({
  onBack,
  onSkip,
  onStart,
  leaving,
}: {
  onBack: () => void;
  onSkip: () => void;
  onStart: () => void;
  leaving: boolean;
}) {
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#087ff5] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] text-white dark:bg-[#073d78]">
      <span className="pointer-events-none absolute -right-24 -top-32 h-72 w-72 rounded-full bg-white/[0.05]" />
      <span className="pointer-events-none absolute -bottom-28 -left-32 h-72 w-72 rounded-full bg-[#006bd9]/55" />
      <OnboardingNavigation
        inverse
        onBack={onBack}
        onSkip={onSkip}
        disabled={leaving}
        busy={leaving}
        className="pt-2"
      />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 text-center">
          <p className="inline-flex items-center gap-2 text-[19px] font-bold">
            <MapPin
              className="h-5 w-5"
              strokeWidth={2.5}
              data-testid="location-agent-heading-icon"
            />
            Location Agent
          </p>
          <h1
            className="mx-auto mt-7 max-w-[410px] text-[38px] font-bold leading-[1.08] tracking-normal"
            data-one-welcome-heading
          >
            Share your location
            <br />
            easily with anyone.
          </h1>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center py-2">
          <WelcomeRadar />
        </div>
        <div className="shrink-0">
          <PrimaryButton inverse onClick={onStart}>
            Get started
          </PrimaryButton>
        </div>
      </div>
      <style>{`
        @media (max-height: 720px) { [data-one-welcome-heading] { margin-top: 12px; font-size: 34px; } }
      `}</style>
    </div>
  );
}

/** Minimal, stylised street-map backdrop used behind the share / check-in art. */
function MapBackdrop({ tone }: { tone: "share" | "checkin" }) {
  const park = tone === "checkin" ? "#dcecd8" : "#dfeede";
  return (
    <svg
      viewBox="0 0 200 168"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
    >
      <rect
        width="200"
        height="168"
        className="fill-[#edf1f6] dark:fill-[#1b222d]"
      />
      {/* green / park blocks */}
      <rect x="10" y="4" width="48" height="42" rx="6" fill={park} />
      <rect x="150" y="98" width="64" height="74" rx="7" fill={park} />
      {/* building blocks */}
      <rect
        x="122"
        y="2"
        width="34"
        height="30"
        rx="4"
        className="fill-[#e4e9f0] dark:fill-[#232c39]"
      />
      <rect
        x="150"
        y="8"
        width="52"
        height="34"
        rx="4"
        className="fill-[#e4e9f0] dark:fill-[#232c39]"
      />
      <rect
        x="8"
        y="118"
        width="44"
        height="48"
        rx="5"
        className="fill-[#e4e9f0] dark:fill-[#232c39]"
      />
      {/* road casings */}
      <path
        d="M-12 86 H212"
        className="stroke-white dark:stroke-[#0f141c]"
        strokeWidth="15"
        fill="none"
      />
      <path
        d="M100 -12 V180"
        className="stroke-white dark:stroke-[#0f141c]"
        strokeWidth="15"
        fill="none"
      />
      <path
        d="M150 58 L214 122"
        className="stroke-white dark:stroke-[#0f141c]"
        strokeWidth="10"
        fill="none"
      />
      {/* road centre hairlines */}
      <path
        d="M-12 86 H212"
        className="stroke-[#dde3ec] dark:stroke-[#2a323f]"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M100 -12 V180"
        className="stroke-[#dde3ec] dark:stroke-[#2a323f]"
        strokeWidth="1.5"
        fill="none"
      />
    </svg>
  );
}

const SHARE_LOCATION_AVATARS = [
  {
    src: "/one-location/onboarding/feature-share-person-1.webp",
    className: "right-[7%] top-[10%]",
  },
  {
    src: "/one-location/onboarding/feature-share-person-2.webp",
    className: "bottom-[10%] left-[3%]",
  },
  {
    src: "/one-location/onboarding/feature-share-person-3.webp",
    className: "bottom-[8%] right-[7%]",
  },
] as const;

function FeatureStatusPill({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative z-30 flex h-8 w-max max-w-full items-center gap-1 rounded-full bg-white/95 px-2 text-[9px] font-bold leading-none text-[#151b26] shadow-[0_5px_16px_rgba(22,35,58,0.15)] dark:bg-[#f4f7fb]",
        className,
      )}
      data-one-use-case-alert
    >
      <span
        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-[#28b867] text-white"
        aria-hidden="true"
      >
        <Check className="h-2.5 w-2.5" strokeWidth={3.5} />
      </span>
      <span className="min-w-max whitespace-nowrap">{children}</span>
    </span>
  );
}

function FeatureStatusRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative z-30 mt-auto flex shrink-0 items-center pb-3",
        className,
      )}
      data-one-feature-status-row
    >
      <FeatureStatusPill>{children}</FeatureStatusPill>
    </div>
  );
}

function TwoLineFeatureTitle({
  lines,
  className,
}: {
  lines: readonly [string, string];
  className?: string;
}) {
  return (
    <div
      role="heading"
      aria-level={2}
      aria-label={lines.join(" ")}
      className={cn(
        "font-bold leading-[1.13] tracking-[-0.015em] text-[#111823] dark:text-white",
        className,
      )}
      data-one-feature-title
    >
      {lines.map((line) => (
        <span
          key={line}
          aria-hidden="true"
          className="block whitespace-nowrap"
          data-one-feature-title-line
        >
          {line}
        </span>
      ))}
    </div>
  );
}

function ShareLocationFeatureCard() {
  return (
    <article
      className="relative flex aspect-[1.72/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#f2f5f8] [container-type:inline-size] dark:bg-[#171d27]"
      data-testid="location-use-case-trip"
      data-one-use-case-card
      data-one-feature-card="share"
    >
      <MapBackdrop tone="share" />
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#f2f5f8] from-[35%] via-[#f2f5f8]/95 via-[51%] to-transparent dark:from-[#171d27] dark:via-[#171d27]/95" />
      <div className="relative z-20 w-[56%] px-5 pt-5" data-one-feature-copy>
        <span
          className="inline-flex rounded-full bg-[color:var(--app-accent-tint)] px-3 py-1 text-[11px] font-bold text-[color:var(--app-accent-deep)]"
          data-one-use-case-tag
        >
          Share location
        </span>
        <TwoLineFeatureTitle
          lines={["No more explaining", "where you are."]}
          className="font-[family-name:var(--font-app-display)] text-[21px]"
        />
        <p
          className="text-[15px] leading-[1.4] text-[#747b86] dark:text-[#aeb8c7]"
          data-one-feature-body
        >
          Share once with family, friends, your driver &mdash; or anyone in your
          Circle.
        </p>
      </div>
      <div
        className="absolute inset-y-0 right-0 z-10 w-[53%]"
        data-one-use-case-art
        aria-hidden="true"
      >
        <svg
          viewBox="0 0 220 240"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <path
            d="M104 119 L178 42 M104 119 L42 198 M104 119 L178 198"
            fill="none"
            stroke="var(--app-accent)"
            strokeWidth="1.5"
            strokeDasharray="3 5"
            opacity="0.72"
          />
        </svg>
        <span className="absolute left-[47%] top-[49%] h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--app-accent)]/10" />
        <span className="absolute left-[47%] top-[49%] h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[color:var(--app-accent)]/15" />
        <span className="absolute left-[47%] top-[49%] h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-[color:var(--app-accent)] shadow-[0_3px_10px_rgba(8,127,245,0.28)] dark:border-[#171d27]" />
        {SHARE_LOCATION_AVATARS.map((avatar, index) => (
          <span
            key={avatar.src}
            className={cn(
              "absolute h-11 w-11 overflow-hidden rounded-full border-[3px] border-white bg-white shadow-[0_5px_14px_rgba(24,57,91,0.2)] dark:border-[#dce5ef]",
              avatar.className,
            )}
            data-one-share-avatar={index + 1}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- Local static art must render in Capacitor static export. */}
            <img
              src={avatar.src}
              alt=""
              loading="eager"
              decoding="async"
              fetchPriority="high"
              className="h-full w-full object-cover"
            />
          </span>
        ))}
      </div>
      <FeatureStatusRow className="px-5">
        Sharing with Mom, Driver +1
      </FeatureStatusRow>
    </article>
  );
}

function CheckInFeatureCard() {
  return (
    <article
      className="relative flex aspect-[0.68/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#f4f6f8] [container-type:inline-size] dark:bg-[#171d27]"
      data-testid="location-use-case-checkin"
      data-one-use-case-card
      data-one-feature-card="checkin"
    >
      <div className="relative z-20 px-4 pt-4" data-one-feature-copy>
        <span
          className="inline-flex rounded-full bg-[#dff4e7] px-3 py-1 text-[11px] font-bold text-[#27884f] dark:bg-[#1c3f2b] dark:text-[#78d69a]"
          data-one-use-case-tag
        >
          Check in
        </span>
        <TwoLineFeatureTitle
          lines={["At the venue, but", "can\u2019t find each other?"]}
          className="text-[19px]"
        />
        <p
          className="text-[14px] leading-[1.4] text-[#747b86] dark:text-[#aeb8c7]"
          data-one-feature-body
        >
          Check in once so your Circle sees your exact spot.
        </p>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-[47%]"
        data-one-use-case-art
        aria-hidden="true"
      >
        <MapBackdrop tone="checkin" />
        <span className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[#f4f6f8] to-transparent dark:from-[#171d27]" />
        <span
          className="absolute bottom-[88px] right-[23%] z-20 h-7 w-7 drop-shadow-[0_7px_9px_rgba(28,177,103,0.26)]"
          data-one-checkin-pin
        >
          <MapPin
            className="h-full w-full fill-[#27b96a] text-[#27b96a]"
            strokeWidth={1.8}
          />
          <span className="absolute left-1/2 top-[37%] h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white" />
        </span>
        <span
          className="absolute bottom-12 left-1/2 w-[54%] -translate-x-1/2"
          style={{ perspective: "320px", perspectiveOrigin: "50% 100%" }}
          data-one-checkin-art
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- Local static art must render in Capacitor static export. */}
          <img
            src="/one-location/onboarding/feature-checkin-house-transparent.webp"
            alt=""
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="block w-full origin-bottom object-contain drop-shadow-[0_8px_10px_rgba(20,30,50,0.22)]"
            style={{ transform: "rotateY(8deg)" }}
            data-one-checkin-hotel
          />
        </span>
      </div>
      <FeatureStatusRow className="px-3">
        Checked in at Hotel Grand
      </FeatureStatusRow>
    </article>
  );
}

function SaveMySoulFeatureCard() {
  return (
    <article
      className="relative flex aspect-[0.68/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#fff3f2] [container-type:inline-size] dark:bg-[#2a191c]"
      data-testid="location-use-case-sos"
      data-one-use-case-card
      data-one-feature-card="sms"
    >
      <div className="relative z-20 px-4 pt-4" data-one-feature-copy>
        <span
          className="inline-flex rounded-full bg-[#ffe0df] px-3 py-1 text-[11px] font-bold text-[#d44442] dark:bg-[#55252a] dark:text-[#ff9a98]"
          data-one-use-case-tag
        >
          SMS &middot; Save My Soul
        </span>
        <TwoLineFeatureTitle
          lines={["Need help but can\u2019t", "call or speak?"]}
          className="text-[19px]"
        />
        <p
          className="text-[14px] leading-[1.4] text-[#747b86] dark:text-[#c2aeb2]"
          data-one-feature-body
        >
          Send an emergency SMS with your live location to trusted contacts.
        </p>
      </div>
      <div
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center"
        data-one-feature-art-region
      >
        <div
          className="relative flex h-[108px] w-[108px] shrink-0 items-center justify-center"
          data-one-sms-radar-clearance
          aria-hidden="true"
        >
          <span
            className="relative flex h-20 w-20 items-center justify-center"
            data-one-sms-radar
          >
            <span
              data-one-onboarding-motion
              data-one-sms-radar-ring
              className="absolute inset-0 rounded-full border-2 border-[#ef302f]/30 bg-[#ef302f]/10 [animation:oneSmsRadar_2.4s_ease-out_infinite]"
            />
            <span
              data-one-onboarding-motion
              data-one-sms-radar-ring
              className="absolute inset-[10px] rounded-full border-2 border-[#ef302f]/25 bg-[#ef302f]/10 [animation:oneSmsRadar_2.4s_ease-out_infinite] [animation-delay:1.2s]"
            />
            <span
              data-one-sms-core
              className="relative z-10 flex h-14 w-14 items-center justify-center text-[15px] font-bold text-white"
            >
              <span
                data-one-onboarding-motion
                data-one-sms-core-pulse
                className="absolute inset-0 rounded-full bg-[#ef302f] shadow-[0_12px_22px_rgba(239,48,47,0.34)] [animation:oneSmsCore_2.4s_ease-in-out_infinite]"
              />
              <span className="relative z-10" data-one-sms-label>
                SMS
              </span>
            </span>
          </span>
        </div>
      </div>
      <FeatureStatusRow className="px-3">
        SMS sent to 3 contacts
      </FeatureStatusRow>
    </article>
  );
}

function FeaturesScreen({
  locationGranted,
  notificationsGranted,
  locationBusy,
  locationPreparationBusy,
  locationPreparationRetry,
  notificationBusy,
  requireLocationToContinue,
  onBack,
  onSkip,
  leaving,
  onContinue,
}: {
  locationGranted: boolean;
  notificationsGranted: boolean;
  locationBusy: boolean;
  locationPreparationBusy: boolean;
  locationPreparationRetry: boolean;
  notificationBusy: boolean;
  requireLocationToContinue: boolean;
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
  onContinue: () => void;
}) {
  const waitingForLocation = requireLocationToContinue && !locationGranted;
  const permissionBusy =
    locationBusy || locationPreparationBusy || notificationBusy;
  const status = locationPreparationBusy
    ? "Preparing your saved place..."
    : locationBusy
      ? "Requesting Location permission..."
      : notificationBusy
        ? "Turning on notifications..."
        : locationPreparationRetry
          ? "We couldn't prepare your saved place. Try again."
          : waitingForLocation
            ? "Allow Location to continue. You stay in control of every share."
            : locationGranted && notificationsGranted
              ? "Location and notifications are ready."
              : "You can adjust permissions later in Location Settings.";

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-white px-6 pb-[max(env(safe-area-inset-bottom,0px),18px)] pt-[max(env(safe-area-inset-top,0px),12px)] dark:bg-[#0c1017]"
      data-one-feature-screen
    >
      <OnboardingNavigation
        floating
        onBack={onBack}
        onSkip={onSkip}
        disabled={leaving}
        busy={leaving}
      />
      <div
        className="flex min-h-0 flex-[0_1_auto] flex-col overflow-hidden"
        data-one-feature-scroll
      >
        <header className="mt-3 shrink-0" data-one-feature-header>
          <h1
            className="text-[36px] font-bold leading-none tracking-[-0.025em] text-[#111823] dark:text-[#f6f8fc]"
            data-one-feature-heading
          >
            Stay connected
          </h1>
          <p
            className="mt-4 text-[17px] leading-[26px] text-[#737a84] dark:text-[#aeb8c7]"
            data-one-feature-subtitle
          >
            For everyday plans, meetups, and emergencies.
          </p>
        </header>
        <div className="mt-6 grid shrink-0 gap-4" data-one-feature-grid>
          <ShareLocationFeatureCard />
          <div
            className="grid grid-cols-2 items-start gap-4"
            data-one-feature-lower-grid
          >
            <CheckInFeatureCard />
            <SaveMySoulFeatureCard />
          </div>
        </div>
        <p
          className={cn(
            "shrink-0 pt-3 text-center text-[11px] font-semibold leading-4 text-[#7d838d] dark:text-[#9ba7b7]",
            !waitingForLocation && !permissionBusy && "sr-only",
          )}
          aria-live="polite"
        >
          {status}
        </p>
      </div>
      <div className="shrink-0 pt-8" data-one-feature-cta>
        <PrimaryButton
          onClick={onContinue}
          busy={permissionBusy}
          disabled={permissionBusy}
          className="h-[58px] min-h-[58px]"
        >
          {locationPreparationRetry ? "Try again" : "Add my people"}
        </PrimaryButton>
      </div>
      <style>{`
        @keyframes oneSmsRadar {
          0% { transform: scale(0.55); opacity: 0.65; }
          80% { opacity: 0; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        @keyframes oneSmsCore {
          0%, 100% { transform: scale(1); box-shadow: 0 14px 26px rgba(239,48,47,0.34); }
          50% { transform: scale(1.06); box-shadow: 0 18px 34px rgba(239,48,47,0.46); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-one-onboarding-motion] { animation: none !important; }
        }
        [data-one-feature-heading] {
          --foundation-title1-size: clamp(36px, 3vw, 40px);
          --foundation-title1-line: 1.05;
        }
        [data-one-feature-copy] {
          --one-feature-copy-gap: 12px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--one-feature-copy-gap);
        }
        @media (max-width: 431px), (min-width: 432px) and (max-height: 920px) {
          [data-one-feature-scroll] { flex: 1 1 0%; }
          [data-one-feature-grid] {
            flex: 1 1 0%;
            min-height: 0;
            grid-template-rows: minmax(0, 0.82fr) minmax(0, 1fr);
          }
          [data-one-feature-lower-grid] {
            height: 100%;
            min-height: 0;
            align-items: stretch;
          }
          [data-one-feature-card] {
            height: 100%;
            min-height: 0;
            aspect-ratio: auto;
          }
        }
        @media (max-height: 780px) {
          [data-one-feature-screen] {
            padding-top: max(env(safe-area-inset-top, 0px), 8px);
            padding-bottom: max(env(safe-area-inset-bottom, 0px), 10px);
          }
          [data-one-onboarding-navigation] { height: 52px; }
          [data-one-feature-header] { margin-top: 8px; }
          [data-one-feature-heading] { --foundation-title1-size: 32px; }
          [data-one-feature-subtitle] { margin-top: 9px; font-size: 15px; line-height: 21px; }
          [data-one-feature-grid] { margin-top: 14px; gap: 12px; }
          [data-one-feature-lower-grid] { gap: 12px; }
          [data-one-feature-cta] { padding-top: 14px; }
          [data-one-feature-cta] button { min-height: 50px; height: 50px; }
        }
        @media (max-height: 680px) {
          [data-one-feature-screen] {
            padding-top: max(env(safe-area-inset-top, 0px), 6px);
            padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
          }
          [data-one-onboarding-navigation] { height: 44px; }
          [data-one-feature-header] { margin-top: 4px; }
          [data-one-feature-heading] { --foundation-title1-size: 30px; }
          [data-one-feature-subtitle] {
            margin-top: 6px;
            font-size: 13px;
            line-height: 17px;
            white-space: nowrap;
          }
          [data-one-feature-grid] { margin-top: 8px; gap: 8px; }
          [data-one-feature-lower-grid] { gap: 8px; }
          [data-one-feature-cta] { padding-top: 8px; }
          [data-one-feature-cta] button { min-height: 46px; height: 46px; }
        }
        @media (max-width: 431px) and (min-height: 820px) {
          [data-one-feature-header] { margin-top: 16px; }
          [data-one-feature-grid] { margin-top: 26px; gap: 14px; }
        }
        @media (max-width: 431px) {
          [data-one-feature-screen] { padding-left: 16px; padding-right: 16px; }
          [data-one-feature-heading] { --foundation-title1-size: 34px; }
          [data-one-feature-subtitle] { font-size: 15px; line-height: 22px; }
          [data-one-feature-grid] {
            gap: 12px;
          }
          [data-one-feature-lower-grid] {
            gap: 12px;
          }
          [data-one-feature-card] {
            border-radius: 22px;
          }
        }
        @media (max-width: 380px) {
          [data-one-feature-screen] { padding-left: 14px; padding-right: 14px; }
        }
        @media (max-width: 340px) {
          [data-one-feature-screen] { padding-left: 12px; padding-right: 12px; }
          [data-one-feature-heading] { --foundation-title1-size: 31px; }
          [data-one-feature-grid] { gap: 10px; }
          [data-one-feature-lower-grid] { gap: 8px; }
          [data-one-feature-card] { border-radius: 20px; }
        }
        @media (max-width: 300px) {
          [data-one-feature-lower-grid] { grid-template-columns: minmax(0, 1fr); }
          [data-one-feature-card="checkin"], [data-one-feature-card="sms"] { aspect-ratio: 1.15 / 1; }
          [data-one-feature-title] { font-size: 16px; }
          [data-one-feature-body] { font-size: 11px; }
          [data-one-use-case-alert] { font-size: 9px; }
        }
        @container (max-width: 420px) {
          [data-one-feature-card="share"] [data-one-feature-copy] {
            --one-feature-copy-gap: 8px;
            width: 60%;
            padding: 16px 14px 0;
          }
          [data-one-feature-card="share"] [data-one-use-case-tag] {
            padding: 3px 9px;
            font-size: 10px;
          }
          [data-one-feature-card="share"] [data-one-feature-title] {
            font-size: 19px;
            line-height: 1.12;
          }
          [data-one-feature-card="share"] [data-one-feature-body] {
            font-size: 14px;
            line-height: 1.35;
          }
          [data-one-feature-card="share"] [data-one-use-case-alert] {
            height: 28px;
            padding-left: 7px;
            padding-right: 7px;
            font-size: 9px;
          }
          [data-one-feature-card="share"] [data-one-feature-status-row] {
            padding-right: 14px;
            padding-left: 14px;
          }
        }
        @container (max-width: 310px) {
          [data-one-feature-card="share"] [data-one-feature-copy] {
            --one-feature-copy-gap: 6px;
            padding: 13px 11px 0;
          }
          [data-one-feature-card="share"] [data-one-use-case-tag] {
            padding: 3px 7px;
            font-size: 10px;
          }
          [data-one-feature-card="share"] [data-one-feature-title] {
            font-size: 17px;
          }
          [data-one-feature-card="share"] [data-one-feature-body] {
            font-size: 12px;
            line-height: 1.3;
          }
          [data-one-feature-card="share"] [data-one-feature-status-row] {
            padding-bottom: 9px;
            padding-right: 11px;
            padding-left: 11px;
          }
          [data-one-feature-card="share"] [data-one-use-case-alert] {
            height: 24px;
            gap: 3px;
            padding-left: 5px;
            padding-right: 5px;
            font-size: 9px;
          }
          [data-one-feature-card="share"] [data-one-use-case-alert] > span:first-child {
            width: 12px;
            height: 12px;
          }
        }
        @container (max-width: 220px) {
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] {
            --one-feature-copy-gap: 6px;
            padding-top: 10px;
            padding-left: 12px;
            padding-right: 10px;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-tag],
          [data-one-feature-card="sms"] [data-one-use-case-tag] {
            padding: 3px 9px;
            font-size: 10px;
          }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] {
            font-size: clamp(15px, calc(5vw - 4.5px), 17px);
            line-height: 1.12;
          }
          [data-one-feature-card="checkin"] [data-one-feature-title] {
            letter-spacing: -0.025em;
          }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] {
            font-size: 13.5px;
            line-height: 1.3;
          }
          [data-one-checkin-pin] {
            top: 14px;
            bottom: auto;
          }
          [data-one-checkin-art] {
            bottom: clamp(54px, calc(65vh - 486.6px), 120px);
          }
          [data-one-feature-card="sms"] [data-one-feature-art-region] {
            align-items: flex-start;
            padding-top: 12px;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-alert],
          [data-one-feature-card="sms"] [data-one-use-case-alert] {
            height: 28px;
            padding-left: 7px;
            padding-right: 7px;
            font-size: 9px;
          }
          [data-one-sms-radar-clearance] { width: 81px; height: 81px; }
          [data-one-sms-radar] { width: 60px; height: 60px; }
          [data-one-sms-core] { width: 44px; height: 44px; font-size: 13px; }
        }
        @container (max-width: 165px) {
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] {
            --one-feature-copy-gap: 4px;
            padding-top: 8px;
            padding-left: 7px;
            padding-right: 5px;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-tag],
          [data-one-feature-card="sms"] [data-one-use-case-tag] {
            padding: 3px 7px;
            font-size: 10px;
          }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] {
            font-size: clamp(14px, 9.5cqw, 15px);
            line-height: 1.08;
          }
          [data-one-feature-card="checkin"] [data-one-feature-title] {
            letter-spacing: -0.05em;
          }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] {
            font-size: 12px;
            line-height: 1.25;
          }
          [data-one-feature-card="checkin"] [data-one-feature-status-row],
          [data-one-feature-card="sms"] [data-one-feature-status-row] {
            padding-right: 6px;
            padding-bottom: 8px;
            padding-left: 6px;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-alert],
          [data-one-feature-card="sms"] [data-one-use-case-alert] {
            height: 24px;
            gap: 3px;
            padding-left: 4px;
            padding-right: 4px;
            font-size: 9px;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-alert] > span:first-child,
          [data-one-feature-card="sms"] [data-one-use-case-alert] > span:first-child {
            width: 12px;
            height: 12px;
          }
          [data-one-checkin-pin] { top: 22px; bottom: auto; width: 24px; height: 24px; }
          [data-one-checkin-art] { bottom: 36px; width: 52%; }
          [data-one-sms-radar-clearance] { width: 54px; height: 54px; }
          [data-one-sms-radar] { width: 40px; height: 40px; }
          [data-one-sms-core] { width: 32px; height: 32px; font-size: 13px; }
        }
        @media (max-width: 431px) and (max-height: 680px) {
          [data-one-feature-heading] { --foundation-title1-size: 30px; }
          [data-one-feature-subtitle] {
            margin-top: 6px;
            font-size: 13px;
            line-height: 17px;
            white-space: nowrap;
          }
          [data-one-feature-card="share"] [data-one-feature-title] { font-size: 17px; }
          [data-one-feature-card="share"] [data-one-feature-body] { font-size: 12px; }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] { font-size: 15px; }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] { font-size: 11.5px; }
          [data-one-feature-grid] { margin-top: 8px; gap: 8px; }
          [data-one-feature-lower-grid] { gap: 8px; }
          [data-one-feature-cta] { padding-top: 8px; }
          [data-one-feature-cta] button { min-height: 46px; height: 46px; }
        }
        @media (max-width: 340px) and (max-height: 680px) {
          [data-one-feature-card="share"] [data-one-feature-title] { font-size: 16px; }
          [data-one-feature-card="share"] [data-one-feature-body] { font-size: 11px; }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] { font-size: 14px; }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] { font-size: 11px; }
        }
        @media (max-width: 365px) and (min-height: 681px) {
          [data-one-checkin-pin] {
            bottom: clamp(54px, calc(40vh - 179.4px), 194px);
          }
          [data-one-checkin-art] {
            bottom: clamp(43px, calc(40vh - 218.4px), 155px);
          }
        }
        @media (max-width: 431px) and (max-height: 560px) {
          [data-one-feature-screen] {
            padding-top: max(env(safe-area-inset-top, 0px), 4px);
            padding-bottom: max(env(safe-area-inset-bottom, 0px), 6px);
          }
          [data-one-onboarding-navigation] { height: 38px; }
          [data-one-feature-header] { margin-top: 2px; }
          [data-one-feature-heading] { --foundation-title1-size: 28px; }
          [data-one-feature-subtitle] {
            margin-top: 4px;
            font-size: 11.5px;
            line-height: 15px;
          }
          [data-one-feature-grid] {
            grid-template-rows: minmax(0, 0.72fr) minmax(0, 1fr);
            margin-top: 6px;
            gap: 6px;
          }
          [data-one-feature-lower-grid] { gap: 6px; }
          [data-one-feature-cta] { padding-top: 6px; }
          [data-one-feature-cta] button { min-height: 42px; height: 42px; }
          [data-one-feature-card="share"] [data-one-feature-copy] {
            --one-feature-copy-gap: 5px;
            width: 60%;
            padding: 9px 9px 0;
          }
          [data-one-feature-card="share"] [data-one-use-case-tag] {
            padding: 2px 7px;
            font-size: 9px;
          }
          [data-one-feature-card="share"] [data-one-feature-title] {
            font-size: 15.5px;
            line-height: 1.08;
          }
          [data-one-feature-card="share"] [data-one-feature-body] {
            font-size: 10px;
            line-height: 1.2;
          }
          [data-one-feature-card="share"] [data-one-feature-status-row] {
            padding-right: 9px;
            padding-bottom: 6px;
            padding-left: 9px;
          }
          [data-one-share-avatar="2"] { left: 20%; }
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] {
            --one-feature-copy-gap: 4px;
            padding-top: 7px;
            padding-left: 6px;
            padding-right: 5px;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-tag],
          [data-one-feature-card="sms"] [data-one-use-case-tag] {
            padding: 2px 6px;
            font-size: 9px;
          }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] {
            font-size: 13px;
            line-height: 1.08;
          }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] {
            font-size: 9.5px;
            line-height: 1.2;
          }
          [data-one-feature-card="checkin"] [data-one-feature-status-row],
          [data-one-feature-card="sms"] [data-one-feature-status-row] {
            padding-right: 5px;
            padding-bottom: 6px;
            padding-left: 5px;
          }
          [data-one-feature-card="share"] [data-one-use-case-alert],
          [data-one-feature-card="checkin"] [data-one-use-case-alert],
          [data-one-feature-card="sms"] [data-one-use-case-alert] {
            height: 22px;
            padding-right: 4px;
            padding-left: 4px;
            font-size: 8px;
          }
          [data-one-feature-card="share"] [data-one-use-case-alert] > span:first-child,
          [data-one-feature-card="checkin"] [data-one-use-case-alert] > span:first-child,
          [data-one-feature-card="sms"] [data-one-use-case-alert] > span:first-child {
            width: 11px;
            height: 11px;
          }
          [data-one-checkin-pin] { top: 8px; }
          [data-one-checkin-art] { bottom: 36px; width: 44%; }
          [data-one-sms-radar-clearance] { width: 40px; height: 40px; }
          [data-one-sms-radar] { width: 32px; height: 32px; }
          [data-one-sms-core] { width: 28px; height: 28px; font-size: 11px; }
        }
      `}</style>
    </div>
  );
}

function SelectionMark({ selected }: { selected: boolean }) {
  return (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
        selected
          ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
          : "border-[#c9cdd3] bg-white text-transparent dark:border-white/25 dark:bg-white/[0.06]",
      )}
      aria-hidden="true"
    >
      <Check className="h-5 w-5" strokeWidth={3} />
    </span>
  );
}

function PeopleScreen({
  people,
  connections,
  loading,
  error,
  initialSelectedIds,
  onRetry,
  onBack,
  onSkip,
  leaving,
  onSelectionChange,
  onContinue,
}: {
  people: DirectoryPerson[];
  connections: ConnectionSummaryEntry[];
  loading: boolean;
  error: string | null;
  initialSelectedIds: string[];
  onRetry: () => void;
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
  onSelectionChange: (selectedIds: string[]) => void;
  onContinue: (selectedIds: string[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>(initialSelectedIds);
  const defaultsAppliedRef = useRef(false);

  const recommendedPeople = useMemo(() => {
    const weight = (relationship: DirectoryPerson["relationship"]) => {
      if (relationship === "connected") return 0;
      if (relationship === "none") return 1;
      return 2;
    };
    return [...people]
      .sort((a, b) => weight(a.relationship) - weight(b.relationship))
      .slice(0, 6);
  }, [people]);

  useEffect(() => {
    if (defaultsAppliedRef.current || recommendedPeople.length === 0) return;
    defaultsAppliedRef.current = true;
    if (initialSelectedIds.length > 0) return;
    const connectedIds = new Set(
      connections.map((connection) => connection.userId),
    );
    setSelectedIds(
      recommendedPeople
        .filter(
          (person) =>
            person.relationship === "connected" ||
            connectedIds.has(person.userId),
        )
        .map((person) => person.userId),
    );
  }, [connections, initialSelectedIds.length, recommendedPeople]);

  useEffect(() => {
    onSelectionChange(selectedIds);
  }, [onSelectionChange, selectedIds]);

  const togglePerson = (person: DirectoryPerson) => {
    if (
      person.relationship === "pending_incoming" ||
      person.relationship === "pending_outgoing"
    ) {
      return;
    }
    setSelectedIds((current) =>
      current.includes(person.userId)
        ? current.filter((userId) => userId !== person.userId)
        : [...current, person.userId],
    );
  };

  const canContinue = !loading;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#14171d]">
      <OnboardingNavigation
        onBack={onBack}
        onSkip={onSkip}
        disabled={leaving}
        busy={leaving}
        className="px-5 pt-2"
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 text-[34px] font-bold leading-[1.06] text-[#151b26] dark:text-[#f5f7fb]">
          Add people
        </h1>
        <p className="mt-2 text-[16px] leading-6 text-[#73777f] dark:text-[#b5bfcc]">
          Invite the people you want to keep connected with.
        </p>
        <h2 className="mt-8 text-[13px] font-semibold tracking-[0.02em] text-[#96999e] dark:text-[#8d99a8]">
          Contacts
        </h2>
        <div className="mt-3 overflow-hidden rounded-[24px] bg-[#f8f9fb] px-4 shadow-[0_10px_30px_rgba(29,45,68,0.08)] dark:bg-[#1c212a] dark:shadow-[0_10px_30px_rgba(0,0,0,0.22)]">
          {loading ? (
            <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-[#777d86]">
              <Loader2 className="h-5 w-5 animate-spin" /> Finding your people
            </div>
          ) : error ? (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-[#6f7580]">
                We could not load recommendations.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="min-h-11 px-4 font-semibold text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]"
              >
                Try again
              </button>
            </div>
          ) : recommendedPeople.length === 0 ? (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center text-[#73777f]">
              <UserPlus className="h-8 w-8 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]" />
              <p className="max-w-[260px] text-sm leading-5">
                No recommendations yet. Refresh after your people open One
                Location.
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="press-scale inline-flex min-h-11 items-center justify-center rounded-full bg-[color:var(--app-accent)] px-5 text-sm font-bold text-[color:var(--app-accent-fg)]"
              >
                Refresh people
              </button>
            </div>
          ) : (
            recommendedPeople.map((person, index) => {
              const selected = selectedIds.includes(person.userId);
              const pending =
                person.relationship === "pending_incoming" ||
                person.relationship === "pending_outgoing";
              return (
                <button
                  key={person.userId}
                  type="button"
                  onClick={() => togglePerson(person)}
                  disabled={pending}
                  aria-pressed={selected}
                  aria-label={`${selected ? "Remove" : "Add"} ${safeName(person.displayName)}`}
                  className={cn(
                    "flex min-h-[88px] w-full items-center gap-3 py-3 text-left",
                    index > 0 &&
                      "border-t border-[#e4e6e9] dark:border-white/[0.08]",
                    pending && "cursor-default opacity-70",
                  )}
                >
                  <Avatar
                    name={safeName(person.displayName)}
                    photoUrl={person.photoUrl}
                    colorSeed={person.userId}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[17px] font-bold text-[#171d28] dark:text-[#f3f6fb]">
                      {safeName(person.displayName)}
                    </span>
                    <span className="block truncate text-[14px] text-[#999ca2] dark:text-[#9ca8b7]">
                      {pending
                        ? "Connection request pending"
                        : person.relationship === "connected"
                          ? "Already in your circle"
                          : person.email || "Available on One"}
                    </span>
                  </span>
                  {pending ? (
                    <span className="shrink-0 rounded-full bg-[#eef1f5] px-3 py-1 text-xs font-semibold text-[#7d828b] dark:bg-white/10 dark:text-white/60">
                      Pending
                    </span>
                  ) : (
                    <SelectionMark selected={selected} />
                  )}
                </button>
              );
            })
          )}
        </div>
        <p className="mx-auto mt-4 max-w-[350px] text-center text-[12px] leading-5 text-[#96999e] dark:text-[#8d99a8]">
          New people receive a Connect request. Location is never shared until
          you approve it.
        </p>
      </div>
      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-3">
        <p
          className="mb-3 h-5 text-center text-[12px] font-semibold text-[#8b8f96] dark:text-[#98a5b5]"
          aria-live="polite"
        >
          {selectedIds.length > 0
            ? `${selectedIds.length} selected`
            : "Select at least one person to continue"}
        </p>
        <PrimaryButton
          onClick={() => onContinue(selectedIds)}
          disabled={!canContinue}
        >
          Continue
        </PrimaryButton>
      </footer>
    </div>
  );
}

function CircleScreen({
  currentUserName,
  currentUserPhotoUrl,
  members,
  requestsSending,
  failedCount,
  settlementRetryCount,
  onBack,
  onSkip,
  leaving,
}: {
  currentUserName: string;
  currentUserPhotoUrl?: string | null;
  members: CircleMember[];
  requestsSending: boolean;
  failedCount: number;
  settlementRetryCount: number;
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
}) {
  const shown = members.slice(0, 4);
  const positions = [
    "left-[42%] top-[-2%]",
    "left-[-1%] top-[38%]",
    "right-[-1%] top-[38%]",
    "bottom-[-2%] left-[13%]",
  ];
  const joinedMember = shown.find((member) => member.status === "connected");
  const joinedFirstName = joinedMember?.displayName.split(/\s+/)[0];
  const subtitle =
    settlementRetryCount > 0
      ? "One is finishing your secure setup. This screen will close when it is ready."
      : failedCount > 0
        ? `${failedCount} invitation could not be sent. You can retry it later from Connect.`
        : requestsSending
          ? "I am sending the invitations now. I will tell you when your people join."
          : joinedFirstName
            ? `${joinedFirstName}'s in. I've invited the rest - I'll tell you when they join.`
            : "I've invited your people - I'll tell you when they join.";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-[max(env(safe-area-inset-top,0px),12px)] dark:bg-[#0c1017]">
      <OnboardingNavigation
        floating
        onBack={onBack}
        onSkip={onSkip}
        disabled={leaving}
        busy={leaving}
      />
      <div className="shrink-0 pt-3 text-left" data-one-circle-heading>
        <h1 className="text-[36px] font-bold leading-[1.05] text-[#111823] dark:text-[#f5f7fb]">
          Your circle is ready.
        </h1>
        <p className="mt-3 min-h-12 max-w-[410px] text-[16px] leading-6 text-[#777d86] dark:text-[#aeb8c7]">
          {subtitle}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 items-start justify-center pt-3">
        <div
          className="relative aspect-square w-[min(88vw,48dvh,390px)]"
          aria-label="Your private circle"
        >
          <span
            data-one-onboarding-motion
            className="absolute inset-[9%] rounded-full border-2 border-dashed border-[#a8d5fb] [animation:oneCircleReady_2.8s_ease-in-out_infinite] dark:border-[#426b91]"
          />
          <span className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <Avatar
              name={currentUserName}
              photoUrl={currentUserPhotoUrl}
              size="lg"
              colorSeed={currentUserName}
            />
            <span className="absolute -inset-2 -z-10 rounded-full border-[3px] border-[#087ff5] bg-white shadow-[0_9px_28px_rgba(8,127,245,0.24)] dark:bg-[#0c1017]" />
          </span>
          {shown.map((member, index) => (
            <span
              key={member.userId}
              data-one-onboarding-motion
              className={cn(
                "absolute z-10 flex w-[82px] flex-col items-center [animation:oneCircleMemberIn_.46s_ease-out_both]",
                positions[index],
              )}
              style={{ animationDelay: `${180 + index * 340}ms` }}
            >
              <span className="relative">
                <Avatar
                  name={member.displayName}
                  photoUrl={member.photoUrl}
                  colorSeed={member.userId}
                />
                {member.status === "connected" ? (
                  <span className="absolute -right-0.5 -top-0.5 h-[18px] w-[18px] rounded-full border-[3px] border-white bg-[#31c65b] dark:border-[#0c1017]" />
                ) : null}
              </span>
              <span className="mt-1 max-w-[82px] truncate text-[12px] font-bold text-[#202736] dark:text-[#e9eef7]">
                {member.displayName.split(" ")[0]}
              </span>
              <span
                className={cn(
                  "mt-0.5 text-[10px] font-semibold",
                  member.status === "connected"
                    ? "text-[#23a64d]"
                    : "text-[#8b919a] dark:text-[#8f9bab]",
                )}
              >
                {member.status === "connected" ? "Joined" : "Invited"}
              </span>
            </span>
          ))}
        </div>
      </div>
      <style>{`
        @keyframes oneCircleReady { 0%, 100% { opacity: .52; transform: scale(.98); } 50% { opacity: 1; transform: scale(1.02); } }
        @keyframes oneCircleMemberIn { from { opacity: 0; transform: translateY(10px) scale(.9); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @media (max-height: 680px) {
          [data-one-onboarding-navigation] { height: 52px; }
          [data-one-circle-heading] { padding-top: 6px; }
          [data-one-circle-heading] h1 { font-size: 31px; }
          [data-one-circle-heading] p { margin-top: 8px; font-size: 14px; line-height: 20px; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-one-onboarding-motion] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}

function initialScreen(startAt: OneLocationOnboardingStart): OnboardingScreen {
  return startAt === "permissions" ? "features" : "welcome";
}

export function OneLocationOnboardingFlow({
  startAt,
  currentUserName,
  currentUserPhotoUrl,
  people,
  connections,
  peopleLoading,
  peopleError,
  locationPermission,
  notificationDeliveryMode,
  notificationBusy,
  locationBusy,
  nativeTest,
  onRetryPeople,
  onSendConnectionRequests,
  onRequestLocation,
  onLocationReady,
  onRequestNotifications,
  onBack,
  onComplete,
  onSkip = onComplete,
  requireLocationToComplete = false,
}: OneLocationOnboardingFlowProps) {
  for (const source of ONBOARDING_IMAGE_SOURCES) {
    preload(source, { as: "image", fetchPriority: "high" });
  }

  const [screen, setScreen] = useState<OnboardingScreen>(() =>
    initialScreen(startAt),
  );
  const [circleMembers, setCircleMembers] = useState<CircleMember[]>([]);
  const [selectedPeopleIds, setSelectedPeopleIds] = useState<string[]>([]);
  const [failedRequestCount, setFailedRequestCount] = useState(0);
  const [requestsSending, setRequestsSending] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [completionBusy, setCompletionBusy] = useState(false);
  const [settlementRetryCount, setSettlementRetryCount] = useState(0);
  const requestBatchRef = useRef(0);
  const requestedConnectionIdsRef = useRef<Set<string>>(new Set());
  const permissionPromptAttemptedRef = useRef(false);
  const locationPreparationCompleteRef = useRef(false);
  const locationPreparationInFlightRef = useRef<Promise<boolean> | null>(null);
  const completionInFlightRef = useRef(false);
  const [locationPreparationBusy, setLocationPreparationBusy] = useState(false);
  const [locationPreparationRetry, setLocationPreparationRetry] =
    useState(false);

  const locationGranted =
    locationPermission?.state === "granted" &&
    locationPermission.locationServicesEnabled !== false;
  const notificationsGranted = notificationDeliveryMode === "push_active";

  const requestMissingPermissions = useCallback(() => {
    if (permissionPromptAttemptedRef.current) return;
    permissionPromptAttemptedRef.current = true;
    const requests: Promise<void>[] = [];
    if (!locationGranted) requests.push(Promise.resolve(onRequestLocation()));
    if (!notificationsGranted) {
      requests.push(Promise.resolve(onRequestNotifications()));
    }
    void Promise.allSettled(requests);
  }, [
    locationGranted,
    notificationsGranted,
    onRequestLocation,
    onRequestNotifications,
  ]);

  const prepareSavedLocation = useCallback((): Promise<boolean> => {
    if (!locationGranted) return Promise.resolve(false);
    if (locationPreparationCompleteRef.current) {
      return Promise.resolve(true);
    }
    if (locationPreparationInFlightRef.current) {
      return locationPreparationInFlightRef.current;
    }

    setLocationPreparationBusy(true);
    setLocationPreparationRetry(false);
    const attempt = Promise.resolve(onLocationReady())
      .then((complete) => {
        locationPreparationCompleteRef.current = complete;
        setLocationPreparationRetry(!complete);
        return complete;
      })
      .catch(() => {
        locationPreparationCompleteRef.current = false;
        setLocationPreparationRetry(true);
        return false;
      })
      .finally(() => {
        locationPreparationInFlightRef.current = null;
        setLocationPreparationBusy(false);
      });
    locationPreparationInFlightRef.current = attempt;
    return attempt;
  }, [locationGranted, onLocationReady]);

  useEffect(() => {
    const nextScreen = initialScreen(startAt);
    setScreen(nextScreen);
    permissionPromptAttemptedRef.current = false;
  }, [startAt]);

  useEffect(() => {
    if (startAt === "permissions") requestMissingPermissions();
  }, [requestMissingPermissions, startAt]);

  useEffect(() => {
    if (screen !== "features" || !locationGranted) return;
    void prepareSavedLocation();
  }, [locationGranted, prepareSavedLocation, screen]);

  useEffect(() => {
    if (screen !== "circle") return;
    const delay = settlementRetryCount === 0 ? 4000 : 3000;
    const timer = window.setTimeout(() => {
      if (completionInFlightRef.current) return;
      completionInFlightRef.current = true;
      setCompletionBusy(true);
      void Promise.resolve(onComplete()).catch(() => {
        completionInFlightRef.current = false;
        setCompletionBusy(false);
        setSettlementRetryCount((current) => current + 1);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [onComplete, screen, settlementRetryCount]);

  const runSkip = async (settleCircle = false) => {
    if (leaving || (settleCircle && completionInFlightRef.current)) return;
    if (settleCircle) {
      completionInFlightRef.current = true;
      setCompletionBusy(true);
    }
    setLeaving(true);
    try {
      await onSkip();
    } catch {
      if (settleCircle) completionInFlightRef.current = false;
      if (settleCircle) {
        setCompletionBusy(false);
        setSettlementRetryCount((current) => current + 1);
      }
      setLeaving(false);
    }
  };

  const runBack = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await onBack();
    } catch {
      setLeaving(false);
    }
  };

  const openFeatures = () => {
    setScreen("features");
    requestMissingPermissions();
  };

  const backFromFeatures = () => {
    if (startAt === "permissions") {
      void runBack();
      return;
    }
    setScreen("welcome");
  };

  const continueFromFeatures = () => {
    if (requireLocationToComplete && !locationGranted) {
      void onRequestLocation();
      return;
    }
    if (locationGranted && !locationPreparationCompleteRef.current) {
      void prepareSavedLocation();
      return;
    }
    setScreen("people");
  };

  const handlePeopleContinue = (selectedIds: string[]) => {
    const selectedPeople = people.filter(
      (person) =>
        selectedIds.includes(person.userId) &&
        person.relationship !== "pending_incoming" &&
        person.relationship !== "pending_outgoing",
    );
    if (selectedPeople.length === 0) {
      toast.error("Choose at least one contact", {
        description:
          "One Location works best with someone in your circle. You can update contacts later from the Connect tab.",
      });
      return;
    }

    setSelectedPeopleIds(selectedPeople.map((person) => person.userId));
    const requestIds = selectedPeople
      .filter(
        (person) =>
          person.relationship === "none" &&
          !requestedConnectionIdsRef.current.has(person.userId),
      )
      .map((person) => person.userId);
    const activeIds = new Set(
      connections.map((connection) => connection.userId),
    );
    const optimisticMembers: CircleMember[] = selectedPeople.map((person) => ({
      userId: person.userId,
      displayName: safeName(person.displayName),
      photoUrl: person.photoUrl,
      status:
        person.relationship === "connected" || activeIds.has(person.userId)
          ? "connected"
          : "pending",
    }));

    setCircleMembers(optimisticMembers);
    setFailedRequestCount(0);
    setRequestsSending(requestIds.length > 0);
    setSettlementRetryCount(0);
    completionInFlightRef.current = false;
    setCompletionBusy(false);
    setScreen("circle");

    const batchId = ++requestBatchRef.current;
    if (requestIds.length === 0) return;
    requestIds.forEach((userId) =>
      requestedConnectionIdsRef.current.add(userId),
    );

    void onSendConnectionRequests(requestIds)
      .then((result) => {
        result.failedUserIds.forEach((userId) =>
          requestedConnectionIdsRef.current.delete(userId),
        );
        if (requestBatchRef.current !== batchId) return;
        const sentIds = new Set(result.sentUserIds);
        setCircleMembers(
          optimisticMembers.filter(
            (member) =>
              member.status === "connected" || sentIds.has(member.userId),
          ),
        );
        setFailedRequestCount(result.failedUserIds.length);
        setRequestsSending(false);
      })
      .catch(() => {
        requestIds.forEach((userId) =>
          requestedConnectionIdsRef.current.delete(userId),
        );
        if (requestBatchRef.current !== batchId) return;
        setCircleMembers(
          optimisticMembers.filter((member) => member.status === "connected"),
        );
        setFailedRequestCount(requestIds.length);
        setRequestsSending(false);
      });
  };

  // Keep the people-screen Skip path aligned with Continue so neither control
  // can bypass the minimum-one-contact onboarding requirement.
  const handlePeopleSkip = () => {
    handlePeopleContinue(selectedPeopleIds);
  };

  return (
    <main
      className="fixed inset-0 z-[540] flex h-dvh min-h-[100svh] w-full items-stretch justify-center overflow-hidden bg-[#eef3f8] text-[#171d28] dark:bg-[#070a0f] dark:text-[#f4f7fb]"
      data-no-route-swipe
      data-testid="one-location-onboarding"
      data-location-onboarding-screen={screen}
    >
      <NativeTestBeacon {...nativeTest} />
      <section
        className={cn(
          "flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[#0c1017]",
          screen === "features"
            ? "max-w-[min(560px,58dvh)] max-[431px]:max-w-none"
            : "max-w-[480px]",
        )}
        data-testid={LOCATION_SCREEN_TEST_IDS[screen]}
      >
        {screen === "welcome" ? (
          <WelcomeScreen
            onBack={() => void runBack()}
            onSkip={() => void runSkip()}
            onStart={openFeatures}
            leaving={leaving}
          />
        ) : null}
        {screen === "features" ? (
          <FeaturesScreen
            locationGranted={locationGranted}
            notificationsGranted={notificationsGranted}
            locationBusy={locationBusy}
            locationPreparationBusy={locationPreparationBusy}
            locationPreparationRetry={locationPreparationRetry}
            notificationBusy={notificationBusy}
            requireLocationToContinue={requireLocationToComplete}
            onBack={backFromFeatures}
            onSkip={() => void runSkip()}
            leaving={leaving}
            onContinue={continueFromFeatures}
          />
        ) : null}
        {screen === "people" ? (
          <PeopleScreen
            people={people}
            connections={connections}
            loading={peopleLoading}
            error={peopleError}
            initialSelectedIds={selectedPeopleIds}
            onRetry={onRetryPeople}
            onBack={() => setScreen("features")}
            onSkip={handlePeopleSkip}
            leaving={leaving}
            onSelectionChange={setSelectedPeopleIds}
            onContinue={handlePeopleContinue}
          />
        ) : null}
        {screen === "circle" ? (
          <CircleScreen
            currentUserName={currentUserName}
            currentUserPhotoUrl={currentUserPhotoUrl}
            members={circleMembers}
            requestsSending={requestsSending}
            failedCount={failedRequestCount}
            settlementRetryCount={settlementRetryCount}
            onBack={() => {
              if (!completionBusy) setScreen("people");
            }}
            onSkip={() => void runSkip(true)}
            leaving={leaving || completionBusy || requestsSending}
          />
        ) : null}
      </section>
    </main>
  );
}
