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
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  Loader2,
  MapPin,
  ShieldCheck,
  UserPlus,
} from "lucide-react";


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

const ONBOARDING_IMAGE_SOURCES = [
  ...WELCOME_ORBIT_ITEMS.map(({ src }) => src),
  "/one-location/onboarding/feature-checkin-house-transparent.webp",
] as const;


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
        "rounded-full text-[16px] font-bold disabled:opacity-50",
        floating
          ? "h-10 min-h-10 bg-white px-5 text-[color:var(--app-accent-deep)] shadow-[0_4px_14px_rgba(26,42,65,0.12)] dark:bg-[#1b222d] dark:text-[color:var(--app-accent-bright)]"
          : inverse
          ? "text-white"
          : "min-h-11 px-2 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]",
      )}
    >
      Skip
    </button>
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
            index === 0 &&
              "[animation:oneWelcomeRing_3s_ease-in-out_infinite]",
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
              className={cn("h-full w-full rounded-[13px]", item.imageClassName)}
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
      <header className="relative z-10 flex h-16 shrink-0 items-center justify-between pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={leaving}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white disabled:opacity-50"
          aria-label="Go back"
        >
          {leaving ? (
            <Loader2 className="h-5 w-5 animate-spin" />
          ) : (
            <ArrowLeft className="h-6 w-6" />
          )}
        </button>
        <OnboardingSkipButton
          inverse
          onClick={onSkip}
          disabled={leaving}
        />
      </header>
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

type UseCaseCardProps = {
  tag: string;
  titleLines: readonly [string, string];
  bodyLines: readonly string[];
  alertText: string;
  kind: "sms" | "share" | "checkin";
  tone: "danger" | "success" | "info";
  testId: string;
};

const USE_CASE_TONES = {
  danger: {
    line: "bg-[#ff4f55]",
    chip: "bg-[#ff4f55] text-white",
  },
  success: {
    line: "bg-[#16a895]",
    chip: "bg-[#16a895] text-white",
  },
  info: {
    line: "bg-[color:var(--app-accent)]",
    chip: "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]",
  },
} as const;

const CHECKIN_AVATARS = [
  { label: "A", color: "#8b5cf6" },
  { label: "J", color: "#3b82f6" },
  { label: "N", color: "#111827" },
  { label: "K", color: "#f59e0b" },
] as const;

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
      <rect width="200" height="168" className="fill-[#edf1f6] dark:fill-[#1b222d]" />
      {/* green / park blocks */}
      <rect x="10" y="4" width="48" height="42" rx="6" fill={park} />
      <rect x="150" y="98" width="64" height="74" rx="7" fill={park} />
      {/* building blocks */}
      <rect x="122" y="2" width="34" height="30" rx="4" className="fill-[#e4e9f0] dark:fill-[#232c39]" />
      <rect x="150" y="8" width="52" height="34" rx="4" className="fill-[#e4e9f0] dark:fill-[#232c39]" />
      <rect x="8" y="118" width="44" height="48" rx="5" className="fill-[#e4e9f0] dark:fill-[#232c39]" />
      {/* road casings */}
      <path d="M-12 86 H212" className="stroke-white dark:stroke-[#0f141c]" strokeWidth="15" fill="none" />
      <path d="M100 -12 V180" className="stroke-white dark:stroke-[#0f141c]" strokeWidth="15" fill="none" />
      <path d="M150 58 L214 122" className="stroke-white dark:stroke-[#0f141c]" strokeWidth="10" fill="none" />
      {/* road centre hairlines */}
      <path d="M-12 86 H212" className="stroke-[#dde3ec] dark:stroke-[#2a323f]" strokeWidth="1.5" fill="none" />
      <path d="M100 -12 V180" className="stroke-[#dde3ec] dark:stroke-[#2a323f]" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

function UseCaseArt({
  kind,
  alertText,
}: {
  kind: UseCaseCardProps["kind"];
  alertText: string;
}) {
  return (
    <div
      className="absolute inset-y-0 right-0 w-[48%]"
      data-one-use-case-art
      data-one-use-case-kind={kind}
      aria-hidden="true"
    >
      {kind === "sms" ? (
        <div
          className="absolute right-[14%] top-[42%] flex h-[92px] w-[92px] -translate-y-1/2 items-center justify-center"
          data-one-sms-radar
        >
          {/* Radar / alarm pulse rings expanding outward from the red core. */}
          <span
            data-one-onboarding-motion
            className="absolute inset-0 rounded-full bg-[#ef302f]/[0.16] [animation:oneSmsRadar_2.4s_ease-out_infinite]"
          />
          <span
            data-one-onboarding-motion
            className="absolute inset-0 rounded-full bg-[#ef302f]/[0.16] [animation:oneSmsRadar_2.4s_ease-out_infinite] [animation-delay:0.8s]"
          />
          <span
            data-one-onboarding-motion
            className="absolute inset-0 rounded-full bg-[#ef302f]/[0.16] [animation:oneSmsRadar_2.4s_ease-out_infinite] [animation-delay:1.6s]"
          />
          <span
            data-one-sms-core
            data-one-onboarding-motion
            className="relative z-10 flex h-[66px] w-[66px] flex-col items-center justify-center rounded-full bg-[#ef302f] text-center text-white shadow-[0_12px_22px_rgba(239,48,47,0.34)] [animation:oneSmsCore_2.4s_ease-in-out_infinite]"
          >
            <span className="text-[16px] font-bold leading-none tracking-tight">
              SMS
            </span>
            <span className="mt-0.5 text-[8px] font-semibold leading-none opacity-90">
              Hold 2 s
            </span>
          </span>
        </div>
      ) : null}

      {kind === "share" ? (
        <>
          <MapBackdrop tone="share" />
          <span className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white to-transparent dark:from-[#171d27]" />
          {/* Dotted live-share route from your dot up to the shared contact. */}
          <svg
            viewBox="0 0 200 168"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full"
            aria-hidden="true"
          >
            <path
              d="M46 128 C 84 118, 116 92, 152 56"
              fill="none"
              stroke="#338df2"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="1 9"
            />
          </svg>
          <span className="absolute bottom-[24%] left-[22%] h-3 w-3 rounded-full bg-[#338df2] ring-[3px] ring-white dark:ring-[#171d27]" />
          <span className="absolute right-[14%] top-[14%] flex h-[34px] w-[34px] items-center justify-center rounded-full border-[3px] border-white bg-[#8b5cf6] text-[13px] font-bold text-white shadow-[0_8px_16px_rgba(124,60,237,0.35)] dark:border-[#171d27]">
            J
            <span className="absolute -bottom-0.5 -right-0.5 flex h-[13px] w-[13px] items-center justify-center rounded-full border-2 border-white bg-[#338df2] text-white dark:border-[#171d27]">
              <Check className="h-1.5 w-1.5" strokeWidth={4} />
            </span>
          </span>

        </>
      ) : null}
      {kind === "checkin" ? (
        <>
          <MapBackdrop tone="checkin" />
          <span className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-white to-transparent dark:from-[#171d27]" />
          {/* eslint-disable-next-line @next/next/no-img-element -- Local static art must render in Capacitor static export. */}
          <img
            src="/one-location/onboarding/feature-checkin-pin-transparent.webp"
            alt=""
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="absolute right-[34%] top-[3%] h-[38%] w-auto object-contain drop-shadow-[0_8px_10px_rgba(22,169,149,0.28)]"
          />
          {/* eslint-disable-next-line @next/next/no-img-element -- Local static art must render in Capacitor static export. */}
          <img
            src="/one-location/onboarding/feature-checkin-house-transparent.webp"
            alt=""
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="absolute bottom-[24%] right-[9%] w-[58%] object-contain drop-shadow-[0_10px_12px_rgba(20,30,50,0.24)]"
            data-one-checkin-art
          />


        </>
      ) : null}
      <span
        className={cn(
          "absolute bottom-[9%] right-[4%] flex w-max items-center gap-1 rounded-full bg-white/95 py-1.5 text-[9px] font-bold text-[#151b26] shadow-[0_6px_18px_rgba(22,35,58,0.18)] dark:bg-[#f4f7fb]",
          kind === "sms" ? "px-3" : "px-2.5",
        )}
        data-one-use-case-alert
      >
        {kind === "share" ? (
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#338df2] text-white">
            <ShieldCheck className="h-2.5 w-2.5" strokeWidth={2.5} />
          </span>
        ) : null}
        {kind === "checkin" ? (
          <span className="mr-0.5 flex -space-x-1.5">
            {CHECKIN_AVATARS.map((avatar) => (
              <span
                key={avatar.label}
                className="flex h-[15px] w-[15px] items-center justify-center rounded-full border border-white text-[7px] font-bold text-white"
                style={{ backgroundColor: avatar.color }}
              >
                {avatar.label}
              </span>
            ))}
          </span>
        ) : null}
        <span className="min-w-max shrink-0 whitespace-nowrap">{alertText}</span>
        <Check
          className={cn(
            "h-3.5 w-3.5 shrink-0",
            kind === "sms"
              ? "text-[#ef302f]"
              : kind === "share"
                ? "text-[#338df2]"
                : "text-[#16a895]",
          )}
          strokeWidth={3}
        />
      </span>
    </div>
  );
}


function UseCaseCard({
  tag,
  titleLines,
  bodyLines,
  alertText,
  kind,
  tone,
  testId,
}: UseCaseCardProps) {
  const colors = USE_CASE_TONES[tone];
  return (
    <article
      className="relative h-full min-h-0 overflow-hidden rounded-[22px] border border-black/[0.03] bg-white shadow-[0_8px_26px_rgba(21,41,70,0.09)] dark:border-white/[0.08] dark:bg-[#171d27] dark:shadow-none"
      data-testid={testId}
      data-one-use-case-card
    >
      <span className={cn("absolute inset-y-0 left-0 w-[5px]", colors.line)} />
      <div
        className="relative z-10 flex h-full min-h-0 w-[64%] min-w-0 flex-col justify-center py-3 pl-4 pr-2"
        data-one-use-case-copy
      >
        <span
          className={cn(
            "w-fit rounded-full px-3 py-1 text-[12px] font-bold",
            colors.chip,
          )}
          data-one-use-case-tag
        >
          {tag}
        </span>
        <div
          role="heading"
          aria-level={2}
          className="mt-2.5 font-[family-name:var(--font-app-display)] text-[16px] font-bold leading-[1.18] text-[#091126] dark:text-white"
          data-one-use-case-title
        >
          {titleLines.map((line) => (
            <span key={line} className="block whitespace-nowrap">
              {line}
            </span>
          ))}
        </div>
        <p
          className="mt-2 text-[13px] leading-[1.34] text-[#777d88] dark:text-[#aeb8c7]"
          data-one-use-case-body
        >
          {bodyLines.map((line) => (
            <span key={line} className="block whitespace-nowrap">
              {line}
            </span>
          ))}
        </p>
      </div>
      <UseCaseArt kind={kind} alertText={alertText} />
    </article>
  );
}

function FeaturesScreen({
  locationGranted,
  notificationsGranted,
  locationBusy,
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
  notificationBusy: boolean;
  requireLocationToContinue: boolean;
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
  onContinue: () => void;
}) {
  const waitingForLocation = requireLocationToContinue && !locationGranted;
  const permissionBusy = locationBusy || notificationBusy;
  const status = locationBusy
    ? "Requesting Location permission..."
    : notificationBusy
      ? "Turning on notifications..."
      : waitingForLocation
        ? "Allow Location to continue. You stay in control of every share."
        : locationGranted && notificationsGranted
          ? "Location and notifications are ready."
          : "You can adjust permissions later in Location Settings.";

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-[#f5f5f7] pb-[max(env(safe-area-inset-bottom,0px),11px)] pl-6 pr-5 pt-[max(env(safe-area-inset-top,0px),55px)] dark:bg-[#0c1017]"
      data-one-feature-screen
    >
      <header
        className="flex h-[42px] shrink-0 items-center justify-between"
        data-one-feature-header
      >
        <button
          type="button"
          onClick={onBack}
          className="press-scale flex h-[42px] w-[42px] items-center justify-center rounded-full bg-white text-[#7b8088] shadow-[0_4px_14px_rgba(26,42,65,0.12)] dark:bg-white/[0.08] dark:text-white"
          aria-label="Go back"
        >
          <ChevronLeft className="h-[22px] w-[22px]" strokeWidth={2} />
        </button>
        <OnboardingSkipButton
          floating
          onClick={onSkip}
          disabled={leaving}
        />
      </header>
      <h1
        className="mt-[15px] shrink-0 text-[32px] font-bold leading-[1.05] tracking-[-0.02em] text-[#091126] dark:text-[#f6f8fc]"
        data-one-feature-heading
      >
        Stay connected
        <br />
        when you need it.
      </h1>
      <div
        className="mt-[18px] grid min-h-0 flex-1 grid-rows-3 gap-3"
        data-one-feature-grid
      >
        <UseCaseCard
          tag="SMS · Save My Soul"
          titleLines={["Need help,", "but can’t call or speak?"]}
          bodyLines={[
            "Send an emergency SMS",
            "with your live location to",
            "trusted contacts.",
          ]}
          alertText="Sent to 3 contacts"
          kind="sms"
          tone="danger"
          testId="location-use-case-sos"
        />

        <UseCaseCard
          tag="Share location"
          titleLines={["Still answering", "“Where are you?”"]}
          bodyLines={[
            "Share your live location safely in",
            "one tap. Stop anytime.",
          ]}
          alertText="Shared securely"
          kind="share"
          tone="info"
          testId="location-use-case-trip"
        />
        <UseCaseCard
          tag="Check in"
          titleLines={["Meeting up,", "but can’t find each other?"]}
          bodyLines={["Check in once so everyone sees", "your exact spot."]}
          alertText="Check-in sent"
          kind="checkin"

          tone="success"
          testId="location-use-case-checkin"
        />
      </div>
      <p
        className={cn(
          "shrink-0 pt-2 text-center text-[10px] font-semibold leading-4 text-[#7d838d] dark:text-[#9ba7b7]",
          !waitingForLocation && !permissionBusy && "sr-only",
        )}
        aria-live="polite"
      >
        {status}
      </p>
      <div
        className="mt-[11px] shrink-0"
        data-one-feature-cta
      >
        <PrimaryButton
          onClick={onContinue}
          busy={permissionBusy}
          disabled={permissionBusy}
          className="h-[52px] min-h-[52px]"
        >
          Continue
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
        @media (max-width: 400px) {
          [data-one-use-case-copy] { width: 60%; padding-left: 16px; padding-right: 4px; }
          [data-one-use-case-tag] { padding: 3px 10px; font-size: 10.5px; }
          [data-one-use-case-title] { margin-top: 7px; font-size: 16px; }
          [data-one-use-case-body] { margin-top: 6px; font-size: 11px; }
          [data-one-use-case-art] { width: 46%; }
        }
        @media (max-height: 760px) {
          [data-one-feature-screen] {
            padding-top: max(env(safe-area-inset-top, 0px), 24px);
            padding-bottom: max(env(safe-area-inset-bottom, 0px), 8px);
          }
          [data-one-feature-heading] { font-size: 29px; }
          [data-one-use-case-card] { border-radius: 20px; }
          [data-one-use-case-copy] { width: 60%; padding: 8px 6px 8px 16px; }
          [data-one-use-case-tag] { padding: 2px 10px; font-size: 10px; }
          [data-one-use-case-title] { margin-top: 5px; font-size: 16px; line-height: 1.08; }
          [data-one-use-case-body] { margin-top: 4px; font-size: 11.5px; line-height: 1.22; }
          [data-one-use-case-art] { width: 46%; }
          [data-one-sms-radar] { width: 88px; height: 88px; }
          [data-one-sms-core] { width: 68px; height: 68px; }
          [data-one-sms-core] > span:first-child { font-size: 17px; }
          [data-one-sms-core] > span:last-child { font-size: 8px; }
          [data-one-use-case-alert] { right: 2%; bottom: 7%; padding: 4px 8px; font-size: 8px; }
          [data-one-use-case-alert] > span:first-child { height: 13px; }
          [data-one-feature-cta] button { min-height: 44px; height: 44px; }
        }
        @media (max-height: 680px) {
          [data-one-feature-heading] { font-size: 26px; }
          [data-one-use-case-copy] { width: 62%; padding-left: 14px; }
          [data-one-use-case-tag] { font-size: 9px; }
          [data-one-use-case-title] { font-size: 14px; }
          [data-one-use-case-body] { font-size: 10px; }
          [data-one-use-case-art] { width: 44%; }
          [data-one-sms-radar] { width: 78px; height: 78px; }
          [data-one-sms-core] { width: 60px; height: 60px; }
          [data-one-use-case-alert] { padding: 3px 6px; font-size: 7px; }
        }
        @media (max-width: 370px) {
          [data-one-use-case-copy] { width: 60%; padding-left: 14px; padding-right: 3px; }
          [data-one-use-case-title] { font-size: 14px; }
          [data-one-use-case-body] { font-size: 9.5px; }
          [data-one-use-case-art] { width: 46%; }
        }
        @media (max-width: 340px) {
          [data-one-feature-screen] { padding-left: 12px; padding-right: 12px; }
          [data-one-use-case-card] { border-radius: 16px; }
          [data-one-use-case-copy] { width: 60%; padding: 5px 2px 5px 12px; }
          [data-one-use-case-tag] { padding: 1px 7px; font-size: 8px; }
          [data-one-use-case-title] { margin-top: 3px; font-size: 13px; line-height: 1.05; }
          [data-one-use-case-body] { margin-top: 3px; font-size: 9px; line-height: 1.12; }
          [data-one-use-case-art] { width: 46%; }
          [data-one-sms-radar] { width: 62px; height: 62px; }
          [data-one-sms-core] { width: 50px; height: 50px; }
          [data-one-sms-core] > span:first-child { font-size: 14px; }
          [data-one-sms-core] > span:last-child { font-size: 7px; }
          [data-one-use-case-alert] { right: 1%; bottom: 5%; padding: 2px 4px; font-size: 6px; gap: 2px; }
          [data-one-use-case-alert] > svg { width: 9px; height: 9px; }
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

  const canContinue = !loading && selectedIds.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#14171d]">
      <header className="flex h-16 shrink-0 items-center justify-between px-5 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] text-[#1f2b3d] dark:bg-white/[0.08] dark:text-white"
          aria-label="Go back"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <OnboardingSkipButton onClick={onSkip} disabled={leaving} />
      </header>
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
}: {
  currentUserName: string;
  currentUserPhotoUrl?: string | null;
  members: CircleMember[];
  requestsSending: boolean;
  failedCount: number;
  settlementRetryCount: number;
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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-[max(env(safe-area-inset-top,0px),24px)] dark:bg-[#0c1017]">
      <div className="shrink-0 pt-2 text-left">
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
          <span className="absolute bottom-[-2%] right-[5%] z-10 flex w-[82px] flex-col items-center">
            <span className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-dashed border-[#91c8f6] bg-[#e8f5ff] text-[#087ff5] dark:border-[#426b91] dark:bg-[#132c43] dark:text-[#68b5ff]">
              <UserPlus className="h-7 w-7" strokeWidth={1.8} />
            </span>
            <span className="mt-1 text-[12px] font-bold text-[#202736] dark:text-[#e9eef7]">
              Add more
            </span>
          </span>
        </div>
      </div>
      <style>{`
        @keyframes oneCircleReady { 0%, 100% { opacity: .52; transform: scale(.98); } 50% { opacity: 1; transform: scale(1.02); } }
        @keyframes oneCircleMemberIn { from { opacity: 0; transform: translateY(10px) scale(.9); } to { opacity: 1; transform: translateY(0) scale(1); } }
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
  const [settlementRetryCount, setSettlementRetryCount] = useState(0);
  const requestBatchRef = useRef(0);
  const permissionPromptAttemptedRef = useRef(false);
  const completionInFlightRef = useRef(false);

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

  useEffect(() => {
    const nextScreen = initialScreen(startAt);
    setScreen(nextScreen);
    permissionPromptAttemptedRef.current = false;
  }, [startAt]);

  useEffect(() => {
    if (startAt === "permissions") requestMissingPermissions();
  }, [requestMissingPermissions, startAt]);

  useEffect(() => {
    if (screen !== "circle") return;
    const delay = settlementRetryCount === 0 ? 4000 : 3000;
    const timer = window.setTimeout(() => {
      if (completionInFlightRef.current) return;
      completionInFlightRef.current = true;
      void Promise.resolve(onComplete()).catch(() => {
        completionInFlightRef.current = false;
        setSettlementRetryCount((current) => current + 1);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [onComplete, screen, settlementRetryCount]);

  const runSkip = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await onSkip();
    } catch {
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

  const continueFromFeatures = () => {
    if (requireLocationToComplete && !locationGranted) {
      void onRequestLocation();
      return;
    }
    setScreen("people");
  };

  const handlePeopleContinue = (selectedIds: string[]) => {
    if (selectedIds.length === 0) return;
    setSelectedPeopleIds(selectedIds);
    const selectedPeople = people.filter((person) =>
      selectedIds.includes(person.userId),
    );
    const requestIds = selectedPeople
      .filter((person) => person.relationship === "none")
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
    setScreen("circle");

    const batchId = ++requestBatchRef.current;
    if (requestIds.length === 0) return;

    void onSendConnectionRequests(requestIds)
      .then((result) => {
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
        if (requestBatchRef.current !== batchId) return;
        setCircleMembers(
          optimisticMembers.filter((member) => member.status === "connected"),
        );
        setFailedRequestCount(requestIds.length);
        setRequestsSending(false);
      });
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
        className="flex h-full min-h-0 w-full max-w-[480px] flex-col overflow-hidden bg-white dark:bg-[#0c1017]"
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
            notificationBusy={notificationBusy}
            requireLocationToContinue={requireLocationToComplete}
            onBack={() => setScreen("welcome")}
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
            onSkip={() => void runSkip()}
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
          />
        ) : null}
      </section>
    </main>
  );
}
