"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  Bell,
  Check,
  Loader2,
  LocateFixed,
  LockKeyhole,
  MapPin,
  ShieldCheck,
  UserPlus,
} from "lucide-react";


import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import type { ConsentNotificationDeliveryMode } from "@/components/consent/notification-provider";
import { isWeb } from "@/lib/capacitor/platform";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import locationOnboardingContract from "@/lib/onboarding/one-location-onboarding.contract.json";

import type {
  ConnectionSummaryEntry,
  DirectoryPerson,
} from "@/lib/services/connections-service";
import { cn } from "@/lib/utils";

type OnboardingScreen =
  | "welcome"
  | "arrival"
  | "checkin"
  | "sos"
  | "people"
  | "circle"
  | "permissions";

const LOCATION_SCREEN_TEST_IDS = Object.fromEntries(
  locationOnboardingContract.screens.map(({ key, testId }) => [key, testId]),
) as Record<OnboardingScreen, string>;

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
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  requireLocationToComplete?: boolean;
};

const FEATURE_SCREENS: OnboardingScreen[] = ["arrival", "checkin", "sos"];

// All static onboarding art. Preloaded on mount so screen-to-screen
// transitions show the illustration instantly instead of fetching it lazily
// the first time each feature screen renders (which caused visible pop-in).
const ONBOARDING_IMAGE_SOURCES = [
  "/one-location/onboarding/arrival-backpack.webp",
  "/one-location/onboarding/checkin-pin.webp",
  "/one-location/onboarding/sos-shield.webp",
  // Dark-mode background-removed cutouts (shown only in dark mode).
  "/one-location/onboarding/arrival-backpack-cutout.webp",
  "/one-location/onboarding/checkin-pin-cutout.webp",
  "/one-location/onboarding/sos-shield-cutout.webp",
  "/one-location/onboarding/akshat.webp",
  "/one-location/onboarding/neelesh.webp",
  "/one-location/onboarding/ankit.webp",
  "/one-location/onboarding/kushal.webp",
] as const;



function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "O";
  return parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
}

function safeName(value: string | null | undefined, fallback = "Someone"): string {
  const normalized = String(value || "").trim();
  return normalized || fallback;
}

function Avatar({
  name,
  photoUrl,
  size = "md",
}: {
  name: string;
  photoUrl?: string | null;
  size?: "sm" | "md" | "lg";
}) {
  const sizeClass =
    size === "lg"
      ? "h-20 w-20 text-2xl"
      : size === "sm"
        ? "h-11 w-11 text-sm"
        : "h-14 w-14 text-base";

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border-[3px] border-white bg-[#dce8f6] font-bold text-[#21364d] shadow-[0_8px_22px_rgba(24,57,91,0.18)]",
        sizeClass,
      )}
      aria-hidden="true"
    >
      {photoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- Directory photos are remote user media.
        <img src={photoUrl} alt="" className="h-full w-full object-cover" />
      ) : (
        initials(name)
      )}
    </span>
  );
}

function TopNavigation({
  onBack,
  onSkip,
  light = false,
}: {
  onBack?: () => void;
  onSkip?: () => void;
  light?: boolean;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between px-5">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "inline-flex h-11 w-11 items-center justify-center transition-transform active:scale-95",
            light
              ? "rounded-full bg-white/18 text-white shadow-[0_8px_20px_rgba(3,31,76,0.16)]"
              : "text-[#1f2b3d] dark:text-[#f4f7fb]",
          )}
          aria-label="Go back"
        >
          <ArrowLeft className="h-7 w-7" aria-hidden="true" />
        </button>
      ) : (
        <span className="h-11 w-11" aria-hidden="true" />
      )}

      {onSkip ? (
        <button
          type="button"
          onClick={onSkip}
          className={cn(
            "min-h-11 rounded-full px-4 text-[16px] font-semibold transition-opacity active:opacity-70",
            light ? "text-white" : "text-[#1f2b3d] dark:text-[#f4f7fb]",
          )}
        >
          Skip
        </button>
      ) : (
        <span className="h-11 w-11" aria-hidden="true" />
      )}
    </div>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
  inverse = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  inverse?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-14 w-full items-center justify-center rounded-full px-6 text-[17px] font-bold shadow-[0_10px_28px_rgba(0,122,255,0.24)] transition-transform active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-55",
        inverse
          ? "bg-white text-[#087cf0] dark:bg-[#101722] dark:text-[color:var(--app-accent-bright)] dark:shadow-[0_12px_28px_rgba(0,0,0,0.32)]"
          : "bg-[#087cf0] text-white hover:bg-[color:var(--app-accent-hover)] dark:bg-[color:var(--app-accent)] dark:text-[#07111f] dark:hover:bg-[#94c7ff]",
      )}
    >
      {children}
    </button>
  );
}

function ProgressDots({ activeIndex }: { activeIndex: number }) {
  return (
    <div className="flex h-5 items-center justify-center gap-2" aria-label={`Step ${activeIndex + 1} of 3`}>
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className={cn(
            "h-2 rounded-full transition-all",
            index === activeIndex
              ? "w-7 bg-[#26334f] dark:bg-[color:var(--app-accent-bright)]"
              : "w-2 bg-[#c9cbd0] dark:bg-white/24",
          )}
        />
      ))}
    </div>
  );
}

function WelcomeRadar({ people }: { people: DirectoryPerson[] }) {
  const connected = people
    .filter((person) => person.relationship === "connected")
    .slice(0, 3);
  // Always render three avatar bubbles in an evenly-spaced triangle around the
  // center pin. Real connected people fill first; remaining slots fall back to
  // dummy contact avatars so the radar never looks empty and keeps consistent
  // distancing from the middle on every device.
  const slots = [0, 1, 2].map((index) => connected[index] ?? null);
  // Three avatars sit on a single ring, spaced an exact 120° apart in a perfect
  // equilateral triangle around the center pin, so they are truly EQUIDISTANT
  // from the middle and from each other. Each avatar is centered on its ring
  // point via a uniform `-translate-x-1/2 -translate-y-1/2`, and the points use
  // the same radius (top at 12%, the two lower ones at 69% / ±33% from center),
  // which gives an identical ~38% center distance for all three.
  const positions = [
    "left-1/2 top-[12%] -translate-x-1/2 -translate-y-1/2",
    "left-[17%] top-[69%] -translate-x-1/2 -translate-y-1/2",
    "left-[83%] top-[69%] -translate-x-1/2 -translate-y-1/2",
  ];


  return (
    <div
      className="relative mx-auto aspect-square w-[min(80vw,34dvh,340px)] drop-shadow-[0_24px_36px_rgba(0,42,102,0.2)]"
      aria-hidden="true"
    >
      {/* Soft radial glow behind everything */}
      <span className="absolute inset-[14%] rounded-full bg-white/10 blur-2xl" />

      {/* Concentric radar rings — evenly stepped radii so the "diameter" reads
          clearly, like a location radar. */}
      {["inset-[3%]", "inset-[19%]", "inset-[35%]"].map((position) => (
        <span
          key={position}
          className={cn(
            "absolute rounded-full border border-white/45 shadow-[0_0_20px_rgba(255,255,255,0.08)]",
            position,
          )}
        />
      ))}

      {/* Animated radar pulse on the outer ring for a subtle "live" feel.
          Opacity-only (no transform scale) so it never grows past the radar
          bounds and can never introduce an unwanted scrollbar. */}
      <span className="absolute inset-[3%] rounded-full border border-white/40 [animation:oneRadarPulse_3s_ease-in-out_infinite]" />
      <style>{`@keyframes oneRadarPulse{0%,100%{opacity:.15}50%{opacity:.6}}`}</style>

      {/* Center hub glow + pin */}

      <span className="absolute inset-[42%] rounded-full bg-white/28 blur-sm shadow-[0_0_42px_rgba(255,255,255,0.5)]" />
      <span className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[5px] border-white/85 bg-white text-[#087cf0] shadow-[0_14px_30px_rgba(0,35,93,0.3)]">
        <MapPin className="h-8 w-8 fill-[#087cf0]/12" strokeWidth={2.25} />
      </span>

      {slots.map((person, index) => (
        <span
          key={person?.userId ?? `dummy-${index}`}
          className={cn("absolute", positions[index])}
        >
          {person ? (
            <Avatar name={safeName(person.displayName)} photoUrl={person.photoUrl} size="lg" />
          ) : (
            <DummyContactAvatar index={index} large />
          )}
          {index === 0 ? (
            <span className="absolute -right-0.5 -top-0.5 h-5 w-5 rounded-full border-[3px] border-white bg-[#34c759]" />
          ) : null}
        </span>
      ))}
    </div>
  );
}



// Real Hushh team faces used for the onboarding teaser illustrations. These
// screens show a sample product preview before any real contacts are chosen, so
// we render actual team photos (not AI art) to keep the UI premium and genuine.
// The images are pre-optimized to small square WebP (240px, ~5KB each) and
// preloaded on mount, so they appear instantly with no layout shift.
const TEAM_AVATAR_SOURCES = [
  "/one-location/onboarding/akshat.webp",
  "/one-location/onboarding/neelesh.webp",
  "/one-location/onboarding/ankit.webp",
  "/one-location/onboarding/kushal.webp",
] as const;

function DummyContactAvatar({ index = 0, large = false }: { index?: number; large?: boolean }) {
  // Match the real <Avatar> circle sizes so sample and real avatars sit on the
  // same radius and never look mismatched when mixed on a screen.
  const sizeClass = large ? "h-20 w-20" : "h-11 w-11";
  const src = TEAM_AVATAR_SOURCES[index % TEAM_AVATAR_SOURCES.length]!;
  return (
    <span
      className={cn(
        "block shrink-0 overflow-hidden rounded-full border-[3px] border-white bg-[#dce8f6] shadow-[0_8px_22px_rgba(24,57,91,0.18)]",
        sizeClass,
      )}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Local static team art must render in Capacitor static export. */}
      <img
        src={src}
        alt=""
        loading="eager"
        decoding="async"
        className="h-full w-full object-cover"
      />
    </span>
  );
}



function FeatureAlert({
  person,
  action,
  detail,
  accent,
  dummyIndex,
}: {
  person?: DirectoryPerson;
  action: string;
  detail?: string;
  accent: "violet" | "teal";
  dummyIndex: number;
}) {
  const name = safeName(person?.displayName, dummyIndex === 0 ? "Akshat" : "Ankit");

  return (
    <div className="absolute left-[6%] top-[7%] z-10 flex min-w-[192px] items-center gap-3 rounded-[16px] bg-white px-3 py-2.5 shadow-[0_12px_28px_rgba(28,42,68,0.18)]">
      <span className="absolute -left-1 -top-4 h-3 w-3">
        <span className={cn("absolute left-0 top-1 h-1 w-3 rotate-[8deg] rounded-full", accent === "teal" ? "bg-[#61d7d4]" : "bg-[#b7a4de]")} />
        <span className={cn("absolute -top-1 left-2 h-3 w-1 -rotate-[10deg] rounded-full", accent === "teal" ? "bg-[#61d7d4]" : "bg-[#b7a4de]")} />
      </span>
      {person?.photoUrl ? (
        <Avatar name={name} photoUrl={person.photoUrl} size="sm" />
      ) : (
        <DummyContactAvatar index={dummyIndex} />
      )}
      <div className="min-w-0 text-left">
        <p className="truncate text-[13px] font-bold text-[#1f2938]">
          {name} {action}
        </p>
        {detail ? <p className="truncate text-[12px] text-[#8a8f98]">{detail}</p> : null}
      </div>
    </div>
  );
}

// Feature illustrations render EDGE-TO-EDGE (full-bleed). The `-mx-5` cancels the
// screen's horizontal padding so the art spans the full card width. Each screen's
// solid background is set to this illustration's own backdrop tone (sampled from
// the artwork), and we paint soft top/bottom fade overlays IN THAT SAME TONE so
// the image dissolves into the screen with zero visible box or crop seam. The
// wrapper has no border, no rounded corner, and no contrasting box color.
//
// `topColor`/`bottomColor` MUST match the FeatureScreen gradient's top and bottom
// stops for that screen. The image is `object-cover` filling a flexible area, so
// its own edges are cropped; these overlays fade the cropped top and bottom into
// the exact screen colors above/below, giving one uniform seamless background.
//
// LIGHT MODE ONLY. In light mode the art shares the screen's light backdrop, so
// fading its edges into that tone gives one seamless full-bleed background. In
// DARK mode we do NOT fade — the light artwork can't dissolve into a dark screen,
// so instead the illustration is presented as a framed rounded card (see the
// `dark:` classes on each illustration wrapper) and these fades are hidden.
function IllustrationFade({
  topColor,
  bottomColor,
}: {
  topColor: string;
  bottomColor: string;
}) {
  return (
    <>
      <span
        className="pointer-events-none absolute inset-x-0 top-0 h-24 dark:hidden"
        style={{ backgroundImage: `linear-gradient(to bottom, ${topColor}, rgba(0,0,0,0))` }}
      />
      <span
        className="pointer-events-none absolute inset-x-0 bottom-0 h-28 dark:hidden"
        style={{ backgroundImage: `linear-gradient(to top, ${bottomColor}, rgba(0,0,0,0))` }}
      />
    </>
  );
}

// Illustration wrapper: full-bleed, edge-to-edge (`-left-5 -right-5`), no border.
// Identical in light and dark; the light/dark difference lives in which image is
// shown inside it (see below).
const ILLUSTRATION_WRAPPER_CLASS =
  "absolute inset-0 -left-5 -right-5 overflow-hidden";

// LIGHT MODE image: the original full-bleed artwork (light background baked in).
// `object-cover` fills the frame and IllustrationFade dissolves its edges into
// the light screen. Hidden in dark mode.
const ILLUSTRATION_IMAGE_CLASS =
  "absolute inset-0 h-full w-full object-cover dark:hidden";

// DARK MODE image: a background-removed cutout (transparent PNG/WebP, generated
// by scripts/onboarding/make-onboarding-cutouts.py). The bright baked-in
// background is gone, so only the character/icon shows — `object-contain` keeps
// it centered and fully visible on the dark screen, with a little padding so it
// never touches the edges. Hidden in light mode. This is the fix for the "bright
// image block looks bad in dark mode" report; light mode is untouched.
const ILLUSTRATION_CUTOUT_CLASS =
  "absolute inset-0 hidden h-full w-full object-contain p-3 dark:block";


// Each illustration fills the flexible area given to it by FeatureScreen
// (`absolute inset-0`), so it grows/shrinks to fit ANY device height and never
// forces the screen to scroll. `-left-5 -right-5` bleeds it past the screen's
// horizontal padding for a true full-width image.
function ArrivalIllustration({ person }: { person?: DirectoryPerson }) {
  return (
    <div
      className={ILLUSTRATION_WRAPPER_CLASS}
      data-testid="arrival-product-preview"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/arrival-backpack.webp"
        alt=""
        className={ILLUSTRATION_IMAGE_CLASS}
        style={{ objectPosition: "center 58%" }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/arrival-backpack-cutout.webp"
        alt=""
        className={ILLUSTRATION_CUTOUT_CLASS}
      />
      <IllustrationFade topColor="#f6f1f0" bottomColor="#eae7ef" />
      <FeatureAlert
        person={person}
        action="arrived"
        detail="at Office"
        accent="violet"
        dummyIndex={0}
      />
    </div>
  );
}

function CheckinIllustration({ person }: { person?: DirectoryPerson }) {
  return (
    <div
      className={ILLUSTRATION_WRAPPER_CLASS}
      data-testid="checkin-product-preview"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/checkin-pin.webp"
        alt=""
        className={ILLUSTRATION_IMAGE_CLASS}
        style={{ objectPosition: "center 58%" }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/checkin-pin-cutout.webp"
        alt=""
        className={ILLUSTRATION_CUTOUT_CLASS}
      />
      <IllustrationFade topColor="#faf2eb" bottomColor="#f5ede9" />
      <FeatureAlert
        person={person}
        action="checked in"
        accent="teal"
        dummyIndex={2}
      />
    </div>
  );
}

function SosIllustration({ people }: { people: DirectoryPerson[] }) {
  const recipients = [people[0], people[1]];
  return (
    <div
      className={ILLUSTRATION_WRAPPER_CLASS}
      data-testid="sos-product-preview"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/sos-shield.webp"
        alt=""
        className={ILLUSTRATION_IMAGE_CLASS}
        style={{ objectPosition: "center 55%" }}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/sos-shield-cutout.webp"
        alt=""
        className={ILLUSTRATION_CUTOUT_CLASS}
      />
      <IllustrationFade topColor="#f5efed" bottomColor="#eae6e8" />

      <span className="absolute left-[8%] top-[53%]">


        {recipients[0]?.photoUrl ? (
          <Avatar name={safeName(recipients[0].displayName)} photoUrl={recipients[0].photoUrl} size="lg" />
        ) : (
          <DummyContactAvatar index={2} large />
        )}
      </span>
      <span className="absolute right-[8%] top-[53%]">
        {recipients[1]?.photoUrl ? (
          <Avatar name={safeName(recipients[1].displayName)} photoUrl={recipients[1].photoUrl} size="lg" />
        ) : (
          <DummyContactAvatar index={3} large />
        )}
      </span>
      <span className="absolute left-[22%] top-[61%] w-[18%] -rotate-[16deg] border-t-2 border-dashed border-[#343b47]" />
      <span className="absolute right-[22%] top-[61%] w-[18%] rotate-[16deg] border-t-2 border-dashed border-[#343b47]" />
      <span className="absolute bottom-[4%] left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-[#68707c] shadow-[0_8px_22px_rgba(28,42,68,0.14)]">
        <ShieldCheck className="h-4 w-4 text-[#f07f92]" /> Help sent
      </span>
    </div>
  );
}

function FeatureScreen({
  screen,
  people,
  onBack,
  onSkip,
  onContinue,
}: {
  screen: "arrival" | "checkin" | "sos";
  people: DirectoryPerson[];
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
}) {
  const featureIndex = FEATURE_SCREENS.indexOf(screen);
  const connectedPeople = people.filter(
    (person) => person.relationship === "connected",
  );
  const arrivalName = safeName(connectedPeople[0]?.displayName, "Akshat");
  const checkinName = safeName(
    connectedPeople[1]?.displayName ?? connectedPeople[0]?.displayName,
    "Ankit",
  );

  const content = {
    arrival: {
      title: "Know when they arrive",
      body: `"${arrivalName} arrived at Office" - get a quiet alert the moment your people reach the places that matter.`,
      visual: <ArrivalIllustration person={connectedPeople[0]} />,
      // The whole screen background is set to the EXACT top/bottom backdrop
      // colors sampled from this illustration's own edges. Combined with the
      // full-bleed (edge-to-edge, no box, no rounded corner) image, the art
      // dissolves into the screen with zero visible seam. Update these together
      // if the artwork is ever re-exported.
      gradient: "from-[#f6f1f0] to-[#eae7ef] dark:from-[#14171d] dark:to-[#14171d]",
      cta: "Continue",
    },
    checkin: {
      title: "Let them know you're here",
      body: `"${checkinName} checked in" - one tap tells your trusted people where you are. No call needed.`,
      visual: <CheckinIllustration person={connectedPeople[1] ?? connectedPeople[0]} />,
      gradient: "from-[#faf2eb] to-[#f5ede9] dark:from-[#14171d] dark:to-[#14171d]",
      cta: "Continue",
    },
    sos: {
      title: "Help when it matters most",
      body: `"Help sent" - SOS shares your live location with selected people, instantly.`,
      visual: <SosIllustration people={connectedPeople} />,
      gradient: "from-[#f5efed] to-[#eae6e8] dark:from-[#14171d] dark:to-[#14171d]",
      cta: "Create my circle",
    },

  }[screen];

  // Fixed, non-scrolling layout: the title and body text are fixed-height rows,
  // and the illustration fills all remaining vertical space (flex-1 + relative)
  // so the whole screen always fits in one viewport on every device — no
  // scrollbar is ever generated. `overflow-hidden` guards against any stray
  // overflow from the full-bleed art or its fades.
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col overflow-hidden bg-gradient-to-b", content.gradient)}>
      <TopNavigation onBack={onBack} onSkip={onSkip} />
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-2">
        <h1 className="mx-auto mb-2 max-w-[360px] shrink-0 text-center text-[clamp(26px,3.4dvh,31px)] font-bold leading-[1.12] text-[#1e2a3d] dark:text-[#f5f7fb]">
          {content.title}
        </h1>
        <div className="relative min-h-0 flex-1">{content.visual}</div>
        <p className="mx-auto mt-2 max-w-[375px] shrink-0 text-center text-[clamp(15px,1.9dvh,17px)] font-semibold leading-[1.4] text-[#263447] dark:text-[#c7cfdb]">
          {content.body}
        </p>
      </div>
      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] pt-2">
        <ProgressDots activeIndex={featureIndex} />
        <div className="mt-2.5">
          <PrimaryButton onClick={onContinue}>{content.cta}</PrimaryButton>
        </div>
      </footer>
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
  onRetry,
  onBack,
  onSkip,
  onContinue,
}: {
  people: DirectoryPerson[];
  connections: ConnectionSummaryEntry[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: (selectedIds: string[]) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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
    const connectedIds = new Set(connections.map((connection) => connection.userId));
    setSelectedIds(
      recommendedPeople
        .filter(
          (person) =>
            person.relationship === "connected" || connectedIds.has(person.userId),
        )
        .map((person) => person.userId),
    );
  }, [connections, recommendedPeople]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#14171d]">
      <TopNavigation onBack={onBack} onSkip={onSkip} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 text-[38px] font-bold leading-[1.05] text-[#151b26] dark:text-[#f5f7fb]">Add people</h1>
        <p className="mt-3 text-[17px] leading-6 text-[#73777f] dark:text-[#b5bfcc]">
          Invite the people you want to keep connected with.
        </p>
        <h2 className="mt-9 text-[13px] font-bold uppercase text-[#96999e] dark:text-[#8d99a8]">
          Contacts
        </h2>


        <div className="mt-3 overflow-hidden rounded-[24px] bg-[#f8f9fb] px-4 shadow-[0_10px_30px_rgba(29,45,68,0.08)] dark:bg-[#1c212a] dark:shadow-[0_10px_30px_rgba(0,0,0,0.22)]">
          {loading ? (
            <div className="flex min-h-44 items-center justify-center gap-2 text-sm text-[#777d86]">
              <Loader2 className="h-5 w-5 animate-spin" /> Finding your people
            </div>
          ) : error ? (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center">
              <p className="text-sm text-[#6f7580]">We could not load recommendations.</p>
              <button type="button" onClick={onRetry} className="min-h-11 px-4 font-semibold text-[#087cf0]">
                Try again
              </button>
            </div>
          ) : recommendedPeople.length === 0 ? (
            <div className="flex min-h-44 flex-col items-center justify-center gap-3 text-center text-[#73777f]">
              <UserPlus className="h-8 w-8 text-[#087cf0]" />
              <p className="max-w-[260px] text-sm leading-5">
                No recommendations yet. You can add people later from Connect.
              </p>
            </div>
          ) : (
            recommendedPeople.map((person, index) => {
              const selected = selectedIds.includes(person.userId);
              const pending = person.relationship.startsWith("pending_");
              return (
                <button
                  key={person.userId}
                  type="button"
                  onClick={() => togglePerson(person)}
                  disabled={pending}
                  className={cn(
                    "flex min-h-[88px] w-full items-center gap-3 py-3 text-left",
                    index > 0 && "border-t border-[#e4e6e9] dark:border-white/[0.08]",
                  )}
                  aria-pressed={selected}
                  aria-label={`${selected ? "Remove" : "Add"} ${safeName(person.displayName)}${pending ? ", request pending" : ""}`}
                >
                  <Avatar name={safeName(person.displayName)} photoUrl={person.photoUrl} />
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
                    <span className="shrink-0 rounded-full bg-[#eef1f5] px-3 py-1 text-xs font-semibold text-[#7d828b]">
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
          New people receive a Connect request. Location is never shared until you approve it.
        </p>
      </div>
      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-3">
        <PrimaryButton onClick={() => onContinue(selectedIds)}>Continue</PrimaryButton>
      </footer>
    </div>
  );
}

function CircleScreen({
  currentUserName,
  currentUserPhotoUrl,
  members,
  failedCount,
  requestsSending,
  onBack,
  onAddPeople,
  onContinue,
}: {
  currentUserName: string;
  currentUserPhotoUrl?: string | null;
  members: CircleMember[];
  failedCount: number;
  requestsSending: boolean;
  onBack: () => void;
  /** Return to the "Add people" screen when the circular add (+) button is tapped. */
  onAddPeople: () => void;
  onContinue: () => void;
}) {
  const pendingCount = members.filter((member) => member.status === "pending").length;
  const connectedCount = members.length - pendingCount;
  const title = pendingCount > 0
    ? "Your circle is taking shape"
    : connectedCount > 0
      ? "You're connected!"
      : "Your circle, your choice";
  const subtitle = requestsSending
    ? `Sending ${pendingCount} connection request${pendingCount === 1 ? "" : "s"}...`
    : pendingCount > 0
      ? `${pendingCount} connection request${pendingCount === 1 ? "" : "s"} sent.`
    : connectedCount > 0
      ? "Here is your circle so far."
      : "Add trusted people anytime from Connect.";
  const shown = members.slice(0, 4);
  const positions = [
    "left-1/2 top-1 -translate-x-1/2",
    "right-1 top-1/2 -translate-y-1/2",
    "bottom-1 left-[16%]",
    "left-1 top-1/2 -translate-y-1/2",
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#14171d]">
      <TopNavigation onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 text-[37px] font-bold leading-[1.08] text-[#151b26] dark:text-[#f5f7fb]">{title}</h1>
        <p className="mt-3 text-[17px] text-[#777b82] dark:text-[#b5bfcc]">{subtitle}</p>

        <div className="relative mx-auto mt-8 aspect-square w-full max-w-[390px]" aria-label="Your private circle">
          <span className="absolute inset-[12%] rounded-full border-2 border-dashed border-[#b9dcfb]" />
          <span className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <Avatar name={currentUserName} photoUrl={currentUserPhotoUrl} size="lg" />
            <span className="absolute -inset-1 -z-10 rounded-full border-[3px] border-[#087cf0] shadow-[0_0_25px_rgba(0,122,255,0.25)]" />
          </span>
          {shown.map((member, index) => (
            <span key={member.userId} className={cn("absolute flex flex-col items-center", positions[index])}>
              <Avatar name={member.displayName} photoUrl={member.photoUrl} />
              <span className="mt-1 max-w-20 truncate text-[12px] font-bold text-[#202736] dark:text-[#e9eef7]">
                {member.displayName.split(" ")[0]}
              </span>
              {member.status === "pending" ? (
                <span className="mt-0.5 rounded-full bg-[#fff3d9] px-2 py-0.5 text-[10px] font-semibold text-[#986a16]">
                  Pending
                </span>
              ) : null}
            </span>
          ))}
          {/* Add-person (+) button — always available so the user can jump back
              to the "Add people" screen to grow their circle. */}
          <button
            type="button"
            onClick={onAddPeople}
            aria-label="Add people to your circle"
            className="absolute bottom-[8%] right-[9%] flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-[#83c4fb] bg-[#eaf5ff] text-[#087cf0] transition-transform active:scale-95 hover:bg-[#dbeeff]"
          >
            <UserPlus className="h-7 w-7" />
          </button>
        </div>

        <div className="mt-5 flex gap-4 rounded-[22px] bg-[#f5f8fb] px-5 py-5 shadow-[0_8px_24px_rgba(35,55,78,0.08)] dark:bg-[#1c212a] dark:shadow-[0_8px_24px_rgba(0,0,0,0.2)]">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#dff0ff] text-[#087cf0]">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-[16px] font-bold text-[#202736] dark:text-[#edf2fa]">Your circle is private</h2>
            <p className="mt-1 text-[14px] leading-5 text-[#747981] dark:text-[#aeb9c7]">
              Only people you approve can see your location. Add or remove people anytime in Connect.
            </p>
          </div>
        </div>
        {failedCount > 0 ? (
          <p role="status" className="mt-3 text-center text-sm text-[#b3413d]">
            {failedCount} request{failedCount === 1 ? "" : "s"} could not be sent. You can retry later in Connect.
          </p>
        ) : null}
      </div>
      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-3">
        <PrimaryButton onClick={onContinue}>Continue</PrimaryButton>
      </footer>
    </div>
  );
}

function PermissionSwitch({
  label,
  checked,
  busy,
  onClick,
}: {
  label: string;
  checked: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onClick}
      disabled={busy}
      className={cn(
        "relative h-10 w-[62px] shrink-0 rounded-full transition-colors disabled:cursor-default",
        checked ? "bg-[#34c759]" : "bg-[#d9dde2] dark:bg-white/[0.16]",
      )}
    >
      <span
        className={cn(
          "absolute left-0 top-1 h-8 w-8 rounded-full bg-white shadow-[0_2px_6px_rgba(0,0,0,0.22)] transition-transform",
          checked ? "translate-x-[26px]" : "translate-x-1",
        )}
      >
        {busy ? <Loader2 className="m-2 h-4 w-4 animate-spin text-[#7c838d]" /> : null}
      </span>
    </button>
  );
}

function PermissionRow({
  icon,
  title,
  description,
  checked,
  busy,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  busy?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex min-h-[132px] items-start gap-4 border-b border-[#e9eaec] py-5 last:border-b-0 dark:border-white/10">
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[#f5f7fa] text-[#0784ee] dark:bg-white/[0.06] dark:text-[color:var(--app-accent-bright)]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-bold text-[#171d28] dark:text-[#f3f6fb]">{title}</h2>
        <p className="mt-1 text-[14px] leading-5 text-[#777c84] dark:text-[#9ca8b7]">{description}</p>
      </div>
      <div className="pt-2">
        <PermissionSwitch
          label={`${title} permission`}
          checked={checked}
          busy={busy}
          onClick={onClick}
        />
      </div>
    </div>
  );
}

function PermissionsScreen({
  canGoBack,
  locationPermission,
  notificationDeliveryMode,
  notificationBusy,
  locationBusy,
  onBack,
  onRequestLocation,
  onRequestNotifications,
  onComplete,
  onSkip,
  requireLocationToComplete,
}: {
  canGoBack: boolean;
  locationPermission: HushhLocationPermissionState | null;
  notificationDeliveryMode: ConsentNotificationDeliveryMode;
  notificationBusy: boolean;
  locationBusy: boolean;
  onBack: () => void;
  onRequestLocation: () => Promise<void>;
  onRequestNotifications: () => Promise<void>;
  onComplete: () => void | Promise<void>;
  onSkip: () => void | Promise<void>;
  requireLocationToComplete: boolean;
}) {
  const locationGranted =
    locationPermission?.state === "granted" &&
    locationPermission.locationServicesEnabled !== false;
  const notificationsGranted = notificationDeliveryMode === "push_active";
  const notificationsBlocked = notificationDeliveryMode === "push_blocked";
  const locationBlocked =
    locationPermission?.state === "denied" ||
    locationPermission?.state === "restricted" ||
    locationPermission?.locationServicesEnabled === false;
  // On web the app cannot open native device Settings — the permission is
  // controlled by the browser's own site-permission UI. Native (iOS/Android)
  // does deep-link into device Settings. Copy must match the platform so we
  // never tell a browser user to "open device Settings".
  const onWeb = isWeb();

  const locationDescription = locationBlocked
    ? onWeb
      ? "Location is blocked for this site. Allow it from your browser's site permissions (the lock icon in the address bar), then try again."
      : "Open device Settings to allow location. It is shared only when you approve."
    : onWeb
      ? "Turn this on and your browser will ask for location. It is shared only when you approve."
      : "Shows your place on the map and powers check-ins. Shared only when you approve.";

  const notificationDescription = notificationsBlocked
    ? onWeb
      ? "Notifications are blocked for this site. Allow them from your browser's site permissions, then try again."
      : "Notifications are blocked. Allow them in device Settings, then try again."
    : "Requests, check-ins, and SOS alerts from your people.";

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#14171d]">
      <TopNavigation
        onBack={canGoBack ? onBack : undefined}
        onSkip={() => void onSkip()}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 max-w-[390px] text-[38px] font-bold leading-[1.06] text-[#151b26] dark:text-[#f5f7fb]">
          A few permissions.<br />Nothing more.
        </h1>
        <div className="mt-6">
          <PermissionRow
            icon={<MapPin className="h-7 w-7" />}
            title="Location"
            description={locationDescription}
            checked={locationGranted}
            busy={locationBusy}
            onClick={() => void onRequestLocation()}
          />
          <PermissionRow
            icon={<Bell className="h-7 w-7" />}
            title="Notifications"
            description={notificationDescription}
            checked={notificationsGranted}
            busy={notificationBusy}
            onClick={() => void onRequestNotifications()}
          />
        </div>
      </div>

      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-2">
        <p className="mb-4 flex items-center justify-center gap-2 text-center text-[12px] leading-4 text-[#8b8f96] dark:text-[#98a5b5]">
          <LockKeyhole className="h-4 w-4 shrink-0" />
          Your location is never sold. Sharing always requires your approval.
        </p>
        <PrimaryButton
          onClick={() => void onComplete()}
          disabled={requireLocationToComplete && !locationGranted}
        >
          Continue
        </PrimaryButton>
      </footer>
    </div>
  );
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
  onComplete,
  onSkip = onComplete,
  requireLocationToComplete = false,
}: OneLocationOnboardingFlowProps) {
  const [screen, setScreen] = useState<OnboardingScreen>(startAt);
  const [circleMembers, setCircleMembers] = useState<CircleMember[]>([]);
  const [failedRequestCount, setFailedRequestCount] = useState(0);
  const [requestsSending, setRequestsSending] = useState(false);
  const requestBatchRef = useRef(0);

  useEffect(() => {
    setScreen(startAt);
  }, [startAt]);

  // Warm the browser cache with every onboarding image the instant the flow
  // mounts. We inject high-priority `<link rel="preload" as="image">` tags
  // (fetched sooner and at higher priority than a plain `new Image()`), and
  // also kick off an eager decode, so the team avatars and illustrations are
  // ready before their screen renders — no slow load or pop-in.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const links: HTMLLinkElement[] = [];
    for (const source of ONBOARDING_IMAGE_SOURCES) {
      const link = document.createElement("link");
      link.rel = "preload";
      link.as = "image";
      link.href = source;
      // `fetchpriority` isn't in every TS DOM lib version as a typed property,
      // so set it via attribute to stay portable while still hinting priority.
      link.setAttribute("fetchpriority", "high");
      document.head.appendChild(link);
      links.push(link);

      const image = new window.Image();
      image.decoding = "async";
      image.setAttribute("fetchpriority", "high");
      image.src = source;
    }

    return () => {
      for (const link of links) link.remove();
    };
  }, []);


  const goBackFromFeature = () => {
    if (screen === "arrival") setScreen("welcome");

    if (screen === "checkin") setScreen("arrival");
    if (screen === "sos") setScreen("checkin");
  };

  const handlePeopleContinue = (selectedIds: string[]) => {
    const selectedPeople = people.filter((person) => selectedIds.includes(person.userId));
    const requestIds = selectedPeople
      .filter((person) => person.relationship === "none")
      .map((person) => person.userId);
    const activeIds = new Set(connections.map((connection) => connection.userId));
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
    setScreen("circle");

    const batchId = ++requestBatchRef.current;
    if (requestIds.length === 0) return;

    void onSendConnectionRequests(requestIds)
      .then((result) => {
        if (requestBatchRef.current !== batchId) return;
        const sentIds = new Set(result.sentUserIds);
        setCircleMembers(
          optimisticMembers.filter(
            (member) => member.status === "connected" || sentIds.has(member.userId),
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

  const handlePeopleSkip = () => {
    setCircleMembers(
      connections.slice(0, 4).map((connection) => ({
        userId: connection.userId,
        displayName: safeName(connection.displayName),
        photoUrl: connection.photoUrl,
        status: "connected",
      })),
    );
    setFailedRequestCount(0);
    setRequestsSending(false);
    requestBatchRef.current += 1;
    setScreen("circle");
  };

  return (
    <main
      className="fixed inset-0 z-[540] flex h-dvh min-h-[100svh] w-full items-stretch justify-center overflow-hidden bg-[#eef3f8] text-[#171d28] dark:bg-[#0c1017] dark:text-[#f4f7fb]"
      data-no-route-swipe
      data-testid="one-location-onboarding"
      data-location-onboarding-screen={screen}
    >
      <NativeTestBeacon {...nativeTest} />
      <section
        className="flex h-full min-h-0 w-full max-w-[480px] flex-col overflow-hidden bg-white shadow-[0_0_40px_rgba(24,57,91,0.08)] dark:bg-[#14171d] dark:shadow-[0_0_44px_rgba(0,0,0,0.48)]"
        data-testid={LOCATION_SCREEN_TEST_IDS[screen]}
      >
        <div className="h-[env(safe-area-inset-top,0px)] shrink-0" />
        {screen === "welcome" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[#087cf0] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] text-white dark:bg-[#0b4c8e]">
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="shrink-0 pt-6 text-center sm:pt-10">
                <p className="inline-flex items-center gap-2 text-[19px] font-bold">
                  <LocateFixed className="h-6 w-6" /> Location
                </p>
                <h1 className="mx-auto mt-6 max-w-[390px] text-[clamp(30px,4.6dvh,38px)] font-bold leading-[1.08]">
                  The people you love.<br />Always in reach.
                </h1>
                <p className="mx-auto mt-4 max-w-[370px] text-[clamp(16px,2dvh,18px)] leading-7 text-white/82">
                  Private by default. Nothing is shared until you approve it.
                </p>
              </div>
              <div className="flex min-h-0 flex-1 items-center justify-center py-2">
                <WelcomeRadar people={people} />
              </div>
              <div className="shrink-0">
                <PrimaryButton inverse onClick={() => setScreen("arrival")}>Get started</PrimaryButton>
              </div>
            </div>
          </div>
        ) : null}


        {screen === "arrival" || screen === "checkin" || screen === "sos" ? (
          <FeatureScreen
            screen={screen}
            people={people}
            onBack={goBackFromFeature}
            onSkip={() => setScreen("people")}
            onContinue={() =>
              setScreen(
                screen === "arrival" ? "checkin" : screen === "checkin" ? "sos" : "people",
              )
            }
          />
        ) : null}

        {screen === "people" ? (
          <PeopleScreen
            people={people}
            connections={connections}
            loading={peopleLoading}
            error={peopleError}
            onRetry={onRetryPeople}
            onBack={() => setScreen("sos")}
            onSkip={handlePeopleSkip}
            onContinue={handlePeopleContinue}
          />
        ) : null}

        {screen === "circle" ? (
          <CircleScreen
            currentUserName={currentUserName}
            currentUserPhotoUrl={currentUserPhotoUrl}
            members={circleMembers}
            failedCount={failedRequestCount}
            requestsSending={requestsSending}
            onBack={() => setScreen("people")}
            onAddPeople={() => setScreen("people")}
            onContinue={() => setScreen("permissions")}
          />
        ) : null}

        {screen === "permissions" ? (
          <PermissionsScreen
            canGoBack={startAt === "welcome"}
            locationPermission={locationPermission}
            notificationDeliveryMode={notificationDeliveryMode}
            notificationBusy={notificationBusy}
            locationBusy={locationBusy}
            onBack={() => setScreen("circle")}
            onRequestLocation={onRequestLocation}
            onRequestNotifications={onRequestNotifications}
            onComplete={onComplete}
            onSkip={onSkip}
            requireLocationToComplete={requireLocationToComplete}
          />
        ) : null}
      </section>
    </main>
  );
}
