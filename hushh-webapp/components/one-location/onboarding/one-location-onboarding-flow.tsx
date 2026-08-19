"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { preconnect, preload } from "react-dom";
import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  MapPin,
  Search,
  Share2,
  UserPlus,
} from "lucide-react";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { filterPeopleByQuery } from "@/lib/one-location/people-search";
import { shouldRevealListControls } from "@/lib/one-location/contact-picker-controls";
import { OnboardingLiveMap } from "@/components/one-location/onboarding/onboarding-live-map";
import {
  READY_MAP_CLASSNAME,
  READY_PANEL_CLASSNAME,
  READY_SURFACE_CLASSNAME,
} from "@/components/one-location/onboarding/ready-panel-layout";
import { normalizeCircleCode } from "@/lib/one-location/pending-circle-join";
import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import type { ConsentNotificationDeliveryMode } from "@/components/consent/notification-provider";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import locationOnboardingContract from "@/lib/onboarding/one-location-onboarding.contract.json";
import { trackEvent } from "@/lib/observability/client";
import { trackLocationFunnelStepCompleted } from "@/lib/observability/growth";
import { resolveRouteId } from "@/lib/observability/route-map";
import { cn } from "@/lib/utils";

type OnboardingScreen = "welcome" | "features" | "contacts" | "invite";

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

/**
 * The user's own Circle invite handle, surfaced on the onboarding "Invite"
 * screen so a brand-new person can copy/share a joinable code before they even
 * build a contact list. The parent (page.tsx) owns provisioning: it finds or
 * creates the person's first Circle and returns its active member-visible code.
 */
export type OnboardingCircleInvite = {
  circleId: string;
  circleName: string;
  code: string;
};

/**
 * Someone from the person's own address book who already has One.
 *
 * Deliberately not the same thing as the directory list this flow used to show:
 * that was every Hushh user, so it asked a new person to share their location
 * with strangers. These are people whose number is already in their phone.
 */
export type OnboardingContactMatch = {
  userId: string;
  displayName: string;
};

/**
 * What a circle code points at, shown before anyone joins it.
 *
 * Seeing the circle's name, its owner and how many people are already in it is
 * the difference between accepting an invitation and accepting a string. It is
 * also the moment where someone decides whether to share their location with
 * these people, which is not a decision to make blind.
 */
export type OnboardingCirclePreview = {
  name: string;
  ownerDisplayName: string;
  memberCount: number;
  alreadyMember: boolean;
};

export type OnboardingContactSyncResult =
  | { status: "matched"; matches: OnboardingContactMatch[] }
  | { status: "none"; partial: boolean }
  | { status: "failed"; message: string; canOpenSettings: boolean };

type OneLocationOnboardingFlowProps = {
  startAt: OneLocationOnboardingStart;
  currentUserName: string;
  locationPermission: HushhLocationPermissionState | null;
  notificationDeliveryMode: ConsentNotificationDeliveryMode;
  notificationBusy: boolean;
  locationBusy: boolean;
  nativeTest: React.ComponentProps<typeof NativeTestBeacon>;
  onRequestLocation: () => Promise<void>;
  onLocationReady: () => Promise<boolean>;
  onRequestNotifications: () => Promise<void>;
  onBack: () => void | Promise<void>;
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  requireLocationToComplete?: boolean;
  /**
   * Label for the final CTA. Setup ends back in the wizard, the workspace ends
   * on the Location hub, and saying so beats a generic "Done" that leaves the
   * person guessing where the button goes.
   */
  completeLabel?: string;
  /**
   * Whether this device can read an address book at all.
   *
   * False on a desktop browser, where there is nothing to read. The step is
   * then skipped rather than rendered as an apology: a screen whose entire
   * content is "this does not work here" is a step that should not exist.
   *
   * This is a platform capability, not a missing prop -- the distinction
   * matters, because a screen that disappears because a caller forgot to pass
   * a handler is the bug this flow just removed.
   */
  /** Where to centre the finale map. Null renders the stylised fallback. */
  mapPoint?: { lat: number; lng: number } | null;
  contactsStepAvailable?: boolean;
  /**
   * Read the address book and return whichever contacts already have One.
   * Called only after the person taps on the contacts screen, never on mount.
   */
  onSyncOnboardingContacts?: () => Promise<OnboardingContactSyncResult>;
  /** Send a connection request to one matched contact. */
  onAddOnboardingContact?: (userId: string) => Promise<void>;
  /** Open the OS settings page so a declined permission can be changed. */
  onOpenContactSettings?: () => void;
  /** Look up a circle code so it can be previewed before joining. */
  onPreviewCircleCode?: (code: string) => Promise<OnboardingCirclePreview>;
  /**
   * Accept a previewed circle. Joining needs a vault, which does not exist
   * during setup, so the parent parks the code and redeems it once one does.
   */
  onAcceptCircleCode?: (code: string) => Promise<void>;
  /**
   * Find-or-create the person's first Circle and return its active,
   * member-visible invite code. Called when the Invite screen opens so a
   * brand-new person always has a code to copy/share.
   */
  onPrepareOnboardingCircleInvite?: () => Promise<OnboardingCircleInvite>;
  /** Copy the invite code to the clipboard (parent owns the toast). */
  onCopyOnboardingCircleCode?: (code: string) => Promise<void> | void;
  /** Open the native/web share sheet with the invite code. */
  onShareOnboardingCircleCode?: (
    invite: OnboardingCircleInvite,
  ) => Promise<void> | void;
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
      className="relative mx-auto aspect-square w-[min(82vw,42dvh,340px)]"
      data-one-welcome-radar
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
        <span
          className="flex h-16 w-16 items-center justify-center rounded-full border border-white/70 bg-white text-[#087ff5] shadow-[0_12px_32px_rgba(0,61,144,0.22)]"
          data-one-welcome-core
        >
          <MapPin className="h-6 w-6 fill-current/10" strokeWidth={2.7} />
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
          <span
            className="block h-[58px] w-[58px] overflow-hidden rounded-[18px] border-[3px] border-white bg-white p-0.5 shadow-[0_12px_28px_rgba(0,40,100,0.28)]"
            data-one-welcome-orbit-card
          >
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
          <span
            className="absolute -right-1 -top-1 h-[17px] w-[17px] rounded-full border-[3px] border-white bg-[#31c65b]"
            data-one-welcome-orbit-status
          />
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
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#087ff5] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-[max(var(--app-safe-area-top-effective,0px),10px)] text-white dark:bg-[#073d78]">
      <span className="pointer-events-none absolute -right-24 -top-32 h-72 w-72 rounded-full bg-white/[0.05]" />
      <span className="pointer-events-none absolute -bottom-28 -left-32 h-72 w-72 rounded-full bg-[#006bd9]/55" />
      <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-[560px] flex-1 flex-col">
        <OnboardingNavigation
          inverse
          onBack={onBack}
          onSkip={onSkip}
          disabled={leaving}
          busy={leaving}
          className="pt-2"
        />
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 text-center">
            <p className="inline-flex items-center gap-2 text-[17px] font-semibold leading-[22px]">
              <MapPin
                className="h-5 w-5"
                strokeWidth={2.5}
                data-testid="location-agent-heading-icon"
              />
              Location Agent
            </p>
            <h1
              className="mx-auto mt-5 max-w-[410px] text-[28px] font-bold leading-[34px] tracking-[-0.015em]"
              data-one-welcome-heading
            >
              Share your location
              <br />
              easily with anyone.
            </h1>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center py-4">
            <WelcomeRadar />
          </div>
          <div className="shrink-0">
            <PrimaryButton inverse onClick={onStart}>
              Get started
            </PrimaryButton>
          </div>
        </div>
      </div>
      <style>{`
        @media (max-height: 720px) {
          [data-one-welcome-heading] { margin-top: 12px; font-size: 28px; line-height: 34px; }
          [data-one-welcome-radar] { width: min(80vw, 42dvh, 320px); }
        }
        @media (max-height: 560px) {
          [data-one-welcome-heading] { margin-top: 8px; font-size: 26px; line-height: 30px; }
          [data-one-welcome-radar] { width: min(76vw, 38dvh, 280px); }
          [data-one-welcome-orbit-card] { width: 52px; height: 52px; }
          [data-one-welcome-core] { width: 58px; height: 58px; }
        }
        @media (max-height: 400px) {
          [data-one-welcome-radar] { width: min(60vw, 32dvh, 220px); }
        }
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

/**
 * Renders in the hero slot (data-one-feature-card="share", keeping that
 * structural key so the ~500 lines of breakpoint tuning below it don't move).
 * The real Check-In flow only tells chosen people you have arrived — it has
 * no hotel or key-pickup capability — so Check-In gets this card's content,
 * promoted to the hero position; Share moves to a compact card below.
 */
function ShareLocationFeatureCard() {
  return (
    <article
      className="relative flex aspect-[1.72/1] w-full flex-col overflow-hidden rounded-[26px] bg-[#f2f5f8] [container-type:inline-size] dark:bg-[#171d27]"
      data-testid="location-use-case-trip"
      data-one-use-case-card
      data-one-feature-card="share"
    >
      <MapBackdrop tone="checkin" />
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#f2f5f8] from-[35%] via-[#f2f5f8]/95 via-[51%] to-transparent dark:from-[#171d27] dark:via-[#171d27]/95" />
      <div className="relative z-20 w-[56%] px-5 pt-5" data-one-feature-copy>
        <span
          className="inline-flex rounded-full bg-[color:var(--app-accent-tint)] px-3 py-1 text-[11px] font-bold text-[color:var(--app-accent-deep)]"
          data-one-use-case-tag
        >
          Check in
        </span>
        <TwoLineFeatureTitle
          lines={["Can’t find", "each other?"]}
          className="font-[family-name:var(--font-app-display)] text-[21px]"
        />
        <p
          className="text-[15px] leading-[1.4] text-[#747b86] dark:text-[#aeb8c7]"
          data-one-feature-body
        >
          Check in once. Everyone knows you arrived.
        </p>
      </div>
      <div
        className="absolute inset-y-0 right-0 z-10 w-[53%]"
        data-one-use-case-art
        aria-hidden="true"
      >
        <span className="absolute left-1/2 top-1/2 z-10 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[3px] border-white bg-[color:var(--app-accent)] shadow-[0_8px_20px_rgba(8,127,245,0.32)] dark:border-[#171d27]">
          <MapPin className="h-7 w-7 text-white" strokeWidth={2.2} />
        </span>
        <span className="absolute left-[calc(50%+18px)] top-[calc(50%-30px)] z-20 flex h-6 w-6 items-center justify-center rounded-full border-[3px] border-white bg-[#28b867] dark:border-[#171d27]">
          <Check className="h-3 w-3 text-white" strokeWidth={3.5} />
        </span>
      </div>
      <FeatureStatusRow className="px-5">Checked in</FeatureStatusRow>
    </article>
  );
}

/**
 * Renders in the first compact slot (data-one-feature-card="checkin"), kept
 * for the same responsive tuning this key already carries. Share's content
 * moved here so it sits beside SMS as an equal compact card, now that
 * Check-In occupies the hero slot above.
 */
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
          className="inline-flex rounded-full bg-[color:var(--app-accent-tint)] px-3 py-1 text-[11px] font-bold text-[color:var(--app-accent-deep)]"
          data-one-use-case-tag
        >
          Share
        </span>
        <TwoLineFeatureTitle
          lines={["Can\u2019t explain", "where you are?"]}
          className="text-[19px]"
        />
        <p
          className="text-[14px] leading-[1.4] text-[#747b86] dark:text-[#aeb8c7]"
          data-one-feature-body
        >
          Share your location in one tap.
        </p>
      </div>
      <div
        className="absolute inset-x-0 bottom-0 h-[47%]"
        data-one-use-case-art
        aria-hidden="true"
      >
        <MapBackdrop tone="share" />
        <span className="pointer-events-none absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-[#f4f6f8] to-transparent dark:from-[#171d27]" />
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <path
            d="M50 62 L30 20"
            fill="none"
            stroke="var(--app-accent)"
            strokeWidth="1.5"
            strokeDasharray="3 5"
            opacity="0.72"
          />
        </svg>
        <span className="absolute left-1/2 top-[62%] h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-[color:var(--app-accent)] shadow-[0_3px_10px_rgba(8,127,245,0.28)] dark:border-[#171d27]" />
        <span className="absolute left-[30%] top-[20%] h-10 w-10 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full border-[3px] border-white bg-white shadow-[0_5px_14px_rgba(24,57,91,0.2)] dark:border-[#dce5ef]">
          {/* eslint-disable-next-line @next/next/no-img-element -- Local static art must render in Capacitor static export. */}
          <img
            src="/one-location/onboarding/feature-share-person-1.webp"
            alt=""
            loading="eager"
            decoding="async"
            fetchPriority="high"
            className="h-full w-full object-cover"
          />
        </span>
      </div>
      <FeatureStatusRow className="px-3">Sharing</FeatureStatusRow>
    </article>
  );
}

/**
 * Visible label is "SMS", matching the Home hub tile and the emergency
 * screen's own button. It read "SOS" for one day (fd73a42b1, reverted here).
 * Internal `data-one-sms-*` hooks keep their name either way; they are
 * structural, not shown, and renaming them buys nothing.
 */
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
          SMS
        </span>
        <TwoLineFeatureTitle
          lines={["Can\u2019t call", "for help?"]}
          className="text-[19px]"
        />
        <p
          className="text-[14px] leading-[1.4] text-[#747b86] dark:text-[#c2aeb2]"
          data-one-feature-body
        >
          Send your location to family and friends.
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
      <FeatureStatusRow className="px-3">Help sent</FeatureStatusRow>
    </article>
  );
}

/*
 * STEP TWO IS THE PRIMER. IT MUST NOT SPRING THE OS DIALOG.
 *
 * This screen used to fire BOTH native permission dialogs — Core Location
 * and push notifications, in parallel — on the same tick as the "Get
 * started" tap that navigated here. The iOS alert landed over a screen the
 * person had not read, and iOS grants exactly one Core Location prompt per
 * install, so a reflexive "Don't Allow" was permanent and only recoverable
 * from Settings (#5395).
 *
 * The three cards below are the explanation. Nothing is asked until the
 * person taps a button that says what it does, which is the same pattern
 * ContactsScreen already uses for the address book. The CTA is one button
 * with three jobs, so the primer costs no extra screen:
 *
 *   not asked yet  -> "Allow location"   asks, once, on an explicit tap
 *   blocked        -> "Open settings"    the only place a refusal is fixable,
 *                     plus "Not now"     because a refusal is not a dead end
 *   granted        -> "Choose my people" the original forward action
 */
function FeaturesScreen({
  locationGranted,
  locationBlocked,
  locationAsked,
  locationBusy,
  locationPreparationBusy,
  locationPreparationRetry,
  notificationBusy,
  requireLocationToContinue,
  onBack,
  onSkip,
  leaving,
  onAllowLocation,
  onOpenLocationSettings,
  onContinue,
}: {
  locationGranted: boolean;
  /** Refused, or the phone's Location Services are off. */
  locationBlocked: boolean;
  /** The Allow button has already been tapped once on this screen. */
  locationAsked: boolean;
  locationBusy: boolean;
  locationPreparationBusy: boolean;
  locationPreparationRetry: boolean;
  notificationBusy: boolean;
  requireLocationToContinue: boolean;
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
  onAllowLocation: () => void;
  onOpenLocationSettings: () => void;
  onContinue: () => void;
}) {
  const permissionBusy =
    locationBusy || locationPreparationBusy || notificationBusy;
  // Asking is the job while Location is neither granted nor refused and has
  // not already been asked once. After that there is nothing left to ask —
  // iOS shows the Core Location alert exactly once per install — so the
  // screen switches to moving on, or to recovery if it was refused.
  const askingIsPending = !locationGranted && !locationBlocked && !locationAsked;
  // A blocked person can still use everything except live sharing, so the
  // flow stays open to them unless the caller says Location is mandatory.
  const canContinueWithoutLocation = locationBlocked && !requireLocationToContinue;

  const status = locationPreparationBusy
    ? "Getting your place ready"
    : locationBusy
      ? "Asking your phone"
      : notificationBusy
        ? "Turning on alerts"
        : locationPreparationRetry
          ? "That didn't work."
          : locationGranted
            ? "Location is on."
            : "";

  return (
    <div
      className="mx-auto flex h-full min-h-0 w-full max-w-[430px] max-[431px]:max-w-none flex-1 flex-col overflow-hidden bg-white px-5 pb-[max(env(safe-area-inset-bottom,0px),18px)] pt-[max(var(--app-safe-area-top-effective,0px),12px)] dark:bg-[#0c1017] sm:px-8 md:max-w-none md:px-10 lg:px-14"
      data-one-feature-screen
    >
      <OnboardingNavigation
        onBack={onBack}
        onSkip={onSkip}
        disabled={leaving}
        busy={leaving}
        /* Same rail as the header and card grid below (both max-w-[700px]).
           Without it the nav was the only full-width row on the screen, so past
           md — where this root drops its 430px cap — Back and Skip slid out to
           the viewport edges while everything else stayed in the column. Passed
           here rather than inside OnboardingNavigation: the welcome screen's
           copy of that nav is already railed at 560 by its parent. */
        className="mx-auto w-full max-w-[700px]"
      />
      <div
        className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto pr-1 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        data-one-feature-scroll
      >
        <header className="mx-auto mt-3 w-full max-w-[700px] shrink-0" data-one-feature-header>
          <h1
            className="ui-text-agent-title text-[#111823] dark:!text-[#f6f8fc]"
            data-one-feature-heading
          >
            Location that helps
          </h1>
          {/* Blocked state stays as its own recovery copy — a distinct error
              state from the marketing subtitle below it, and the only place
              that explains why the button turned into "Open settings". */}
          <p
            className="mt-3 text-[15px] font-normal leading-[20px] text-[#737a84] dark:text-[#aeb8c7]"
            data-one-feature-subtitle
            data-testid="one-location-onboarding-location-reason"
          >
            {locationBlocked
              ? "Location is off. Turn it on in Settings."
              : "Share, check in, or get help."}
          </p>
        </header>
        <div className="mx-auto mt-6 grid w-full max-w-[700px] shrink-0 gap-4" data-one-feature-grid>
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
            !permissionBusy && !locationPreparationRetry && "sr-only",
          )}
          aria-live="polite"
        >
          {status}
        </p>
      </div>
      <div className="mx-auto w-full max-w-[560px] shrink-0 pt-5" data-one-feature-cta>
        <PrimaryButton
          onClick={
            askingIsPending
              ? onAllowLocation
              : locationBlocked
                ? onOpenLocationSettings
                : onContinue
          }
          busy={permissionBusy}
          disabled={permissionBusy}
          className="h-[58px] min-h-[58px]"
        >
          {/* Four jobs, one button. "Choose my people" names the next screen —
              a deliberately distinct string, so the reviewer flow's exact
              button match cannot collide with a generic "Continue". */}
          {locationPreparationRetry
            ? "Try again"
            : askingIsPending
              ? "Allow location"
              : locationBlocked
                ? "Open settings"
                : "Choose my people"}
        </PrimaryButton>
        {/* A refusal is not a dead end. Everything except live sharing still
            works, so the only screen that must hold someone is one whose
            caller made Location mandatory. */}
        {canContinueWithoutLocation ? (
          <button
            type="button"
            onClick={onContinue}
            disabled={permissionBusy}
            data-testid="one-location-onboarding-skip-location"
            className="press-scale mt-2 min-h-11 w-full rounded-full text-[16px] font-bold text-[color:var(--app-accent-deep)] disabled:opacity-50 dark:text-[color:var(--app-accent-bright)]"
          >
            Not now
          </button>
        ) : null}
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
          --foundation-title1-size: 34px;
          --foundation-title1-line: 1.08;
        }
        [data-one-feature-copy] {
          --one-feature-copy-gap: 12px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--one-feature-copy-gap);
        }
        @media (max-width: 431px), (min-width: 432px) and (max-height: 920px) {
          [data-one-feature-scroll] { flex: 1 1 auto; }
          [data-one-feature-grid] {
            flex: 0 0 auto;
            min-height: 0;
            grid-template-rows: auto;
          }
          [data-one-feature-lower-grid] {
            height: auto;
            min-height: 0;
            align-items: stretch;
          }
          [data-one-feature-card] {
            height: auto;
            min-height: 0;
          }
        }
        @media (max-height: 780px) {
          [data-one-feature-screen] {
            padding-top: max(var(--app-safe-area-top-effective, 0px), 8px);
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
            padding-top: max(var(--app-safe-area-top-effective, 0px), 6px);
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
        @media (min-width: 768px) {
          [data-one-feature-scroll] {
            align-items: center;
            flex: 0 0 auto;
            padding-right: 0;
          }
          [data-one-feature-header] {
            margin-top: 18px;
            max-width: 1040px;
          }
          [data-one-feature-heading] {
            --foundation-title1-size: 34px;
          }
          [data-one-feature-grid] {
            display: grid;
            grid-template-columns: repeat(3, minmax(0, 1fr));
            grid-template-areas:
              "share checkin sms";
            align-items: stretch;
            width: 100%;
            max-width: 1040px;
            margin-top: 24px;
            gap: 18px;
          }
          [data-one-feature-lower-grid] {
            display: contents;
          }
          [data-one-feature-card] {
            min-height: 0;
          }
          [data-one-feature-card="share"] {
            grid-area: share;
            aspect-ratio: auto;
            min-height: 390px;
          }
          [data-one-feature-card="checkin"] {
            grid-area: checkin;
          }
          [data-one-feature-card="sms"] {
            grid-area: sms;
          }
          [data-one-feature-card="checkin"],
          [data-one-feature-card="sms"] {
            aspect-ratio: auto;
            min-height: 390px;
          }
          [data-one-feature-card="share"] [data-one-feature-copy] {
            width: auto;
            padding: 20px 18px 0;
          }
          [data-one-feature-card="share"] [data-one-use-case-art] {
            inset: auto 0 42px 0;
            width: 100%;
            height: 50%;
          }
          [data-one-feature-card="share"] [data-one-feature-title],
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] {
            font-size: 20px;
            line-height: 1.14;
          }
          [data-one-feature-card="share"] [data-one-feature-body],
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] {
            font-size: 15px;
            line-height: 1.35;
          }
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] {
            width: auto;
            padding: 20px 18px 0;
          }
          [data-one-feature-card="checkin"] [data-one-use-case-art] {
            inset: auto 0 42px 0;
            width: 100%;
            height: 46%;
          }
          [data-one-feature-card="checkin"] [data-one-checkin-art] {
            left: 50%;
            width: 42%;
          }
          [data-one-feature-card="sms"] [data-one-feature-art-region] {
            position: relative;
            inset: auto;
            align-items: center;
            justify-content: center;
          }
          [data-one-feature-card="sms"] [data-one-sms-radar-clearance] {
            width: 108px;
            height: 108px;
          }
          [data-one-feature-card="checkin"] [data-one-feature-status-row],
          [data-one-feature-card="sms"] [data-one-feature-status-row] {
            padding-right: 18px;
            padding-left: 18px;
          }
          [data-one-feature-cta] {
            max-width: 430px;
            padding-top: 22px;
            padding-bottom: 4px;
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
          [data-one-checkin-art] { width: 52%; }
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
        @media (max-width: 431px) and (max-height: 560px) {
          [data-one-feature-screen] {
            padding-top: max(var(--app-safe-area-top-effective, 0px), 4px);
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
            grid-template-rows: auto;
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
          [data-one-checkin-art] { width: 44%; }
          [data-one-sms-radar-clearance] { width: 40px; height: 40px; }
          [data-one-sms-radar] { width: 32px; height: 32px; }
          [data-one-sms-core] { width: 28px; height: 28px; font-size: 11px; }
        }
        @media (min-width: 768px) {
          [data-one-feature-card="share"] [data-one-feature-copy],
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] {
            width: auto;
            padding: 20px 18px 0;
          }
          [data-one-feature-card="share"] [data-one-feature-title],
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] {
            font-size: 20px;
            line-height: 1.14;
          }
          [data-one-feature-card="share"] [data-one-feature-body],
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] {
            font-size: 15px;
            line-height: 1.35;
          }
        }
      `}</style>
    </div>
  );
}

function formatCircleCode(code: string): string {
  const compact = String(code || "")
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "");
  if (!compact) return "";
  return compact.replace(/(.{4})(?=.)/g, "$1-");
}

/**
 * Third onboarding screen (before the contact list). A brand-new person always
 * lands here with their own Circle invite code ready to copy/share, so friends
 * can set up their One account and later join the Location Circle with it. The
 * code is member-visible only and is never placed in a URL.
 */
/**
 * Find the people you already know who are already on One.
 *
 * Primed, not sprung: the OS contacts prompt fires only after the person taps
 * the button on this screen, which is what lifts opt-in and is how Snapchat
 * ties the prompt to "find friends" rather than to app launch. Every state has
 * a way forward, so nobody is stuck behind a permission they declined.
 */
function ContactsScreen({
  state,
  matches,
  addedUserIds,
  addingUserIds,
  onSync,
  onAdd,
  onOpenSettings,
  onBack,
  onSkip,
  onContinue,
  leaving,
}: {
  state:
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "none"; partial: boolean }
    | { kind: "matched" }
    | { kind: "failed"; message: string; canOpenSettings: boolean };
  matches: OnboardingContactMatch[];
  addedUserIds: string[];
  addingUserIds: string[];
  onSync: () => void;
  onAdd: (userId: string) => void;
  onOpenSettings: () => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
  leaving: boolean;
}) {
  const primed = state.kind === "idle" || state.kind === "busy";

  // A synced address book can match well past a screenful (issue #5564), so
  // matches get the same word-beginning search every other people list on
  // Location already uses. The body above already owns the screen's one
  // scroll surface (`overflow-y-auto` on the flex-1 wrapper below), so this
  // list stays a plain `<ul>` rather than nesting a second scroller inside it.
  const [matchesQuery, setMatchesQuery] = useState("");
  const filteredMatches = useMemo(
    () => filterPeopleByQuery(matches, matchesQuery, (match) => match.displayName),
    [matches, matchesQuery],
  );
  const showMatchesSearch = shouldRevealListControls(
    matches.length,
    matchesQuery.trim().length > 0,
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-white dark:bg-[#14171d]"
      data-testid="one-location-onboarding-contacts-surface"
    >
      {/* pt clears the status bar and notch. A bare pt-2 put Back and Skip
          under the clock and battery on every notched iPhone -- reachable
          only by guessing where they were. */}
      <header className="flex min-h-16 shrink-0 items-center justify-between px-5 pb-2 pt-[max(var(--app-safe-area-top-effective,0px),8px)]">
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
        <span className="mt-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
          <UserPlus className="h-7 w-7" strokeWidth={2} />
        </span>
        <h1 className="ui-text-agent-title mt-4 text-[#151b26] dark:!text-[#f5f7fb]">
          Find your people
        </h1>
        <p className="mt-2 text-[15px] font-normal leading-[20px] text-[#73777f] dark:text-[#b5bfcc]">
          {primed
            ? "Find contacts already on One."
            : state.kind === "matched"
              ? "Add anyone you trust."
              : "You can always find people later from the People tab."}
        </p>

        {primed ? (
          <>
            <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 dark:border-white/[0.08] dark:bg-[#1c212a]">
              {state.kind === "busy" ? (
                <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-[#777d86] dark:text-[#8d99a8]">
                  <Loader2 className="h-5 w-5 animate-spin" /> Checking your
                  contacts
                </div>
              ) : (
                <div className="flex min-h-32 flex-col justify-center gap-3">
                  {/* Say what happens to the address book before asking for it.
                      A vague ask on a location product is what makes people
                      decline, and the decline is permanent on iOS. */}
                  <p className="text-[14px] leading-5 text-[#5c626c] dark:text-[#aeb8c7]">
                    Your contacts are checked using a one-way hash. One never
                    stores your contact list, and nobody is contacted for you.
                  </p>
                  <PrimaryButton onClick={onSync} disabled={leaving}>
                    Check my contacts
                  </PrimaryButton>
                </div>
              )}
            </div>
          </>
        ) : null}

        {state.kind === "matched" ? (
          <>
            {showMatchesSearch ? (
              <label className="relative mt-6 block">
                <span className="sr-only">Search contacts</span>
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#96999e] dark:text-[#8d99a8]" />
                <input
                  value={matchesQuery}
                  onChange={(event) => setMatchesQuery(event.target.value)}
                  placeholder="Search contacts"
                  autoComplete="off"
                  className="h-11 w-full rounded-full border border-[#e4e6e9] bg-white pl-11 pr-4 text-[15px] text-[#151b26] outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)] dark:border-white/[0.08] dark:bg-[#1c212a] dark:text-[#f5f7fb]"
                  data-testid="onboarding-contact-matches-search"
                />
              </label>
            ) : null}

            {filteredMatches.length === 0 ? (
              <p className="mt-6 text-center text-[14px] leading-5 text-[#96999e] dark:text-[#8d99a8]">
                No contacts match “{matchesQuery.trim()}”.
              </p>
            ) : (
          <ul className="mt-6 space-y-2" data-testid="onboarding-contact-matches">
            {filteredMatches.map((match) => {
              const added = addedUserIds.includes(match.userId);
              const adding = addingUserIds.includes(match.userId);
              return (
                <li
                  key={match.userId}
                  className="flex items-center justify-between gap-3 rounded-2xl border border-[#e4e6e9] bg-white px-4 py-3 dark:border-white/[0.08] dark:bg-[#1c212a]"
                >
                  <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-[#151b26] dark:text-[#f5f7fb]">
                    {match.displayName}
                  </span>
                  <button
                    type="button"
                    onClick={() => onAdd(match.userId)}
                    disabled={added || adding || leaving}
                    className="press-scale inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-full bg-[color:var(--app-accent)] px-4 text-[14px] font-bold text-[color:var(--app-accent-fg)] disabled:opacity-60"
                  >
                    {adding ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : added ? (
                      <Check className="h-4 w-4" strokeWidth={2.5} />
                    ) : null}
                    {added ? "Requested" : adding ? "Adding" : "Add"}
                  </button>
                </li>
              );
            })}
          </ul>
            )}
          </>
        ) : null}

        {state.kind === "none" ? (
          <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 text-center dark:border-white/[0.08] dark:bg-[#1c212a]">
            <p className="text-[15px] leading-5 text-[#5c626c] dark:text-[#aeb8c7]">
              {state.partial
                ? "None of the contacts you shared are on One yet."
                : "None of your contacts are on One yet."}
            </p>
            <p className="mt-2 text-[13px] leading-5 text-[#96999e] dark:text-[#8d99a8]">
              Your circle code is on the next screen — send it to whoever you
              want here.
            </p>
          </div>
        ) : null}

        {state.kind === "failed" ? (
          <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 text-center dark:border-white/[0.08] dark:bg-[#1c212a]">
            <p className="text-[15px] leading-5 text-[#5c626c] dark:text-[#aeb8c7]">
              {state.message}
            </p>
            {state.canOpenSettings ? (
              <button
                type="button"
                onClick={onOpenSettings}
                className="press-scale mt-4 inline-flex min-h-11 items-center justify-center rounded-full border border-[#d5d9df] bg-white px-5 text-sm font-bold text-[#1f2b3d] dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
              >
                Open Settings
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-3">
        {/* Always present, whatever happened above. Declining contacts, finding
            nobody, or a plugin failure must never be a dead end. */}
        <PrimaryButton
          onClick={onContinue}
          disabled={leaving}
          inverse={primed && state.kind === "idle"}
        >
          {state.kind === "idle" ? "Not now" : "Continue"}
        </PrimaryButton>
      </footer>
    </div>
  );
}

/**
 * The last thing a new person sees: themselves, on a real map.
 *
 * This screen used to be a wall -- a code to copy before you were allowed
 * through. That is an errand, not a reason to stay. The map is the product, so
 * the map is the finale: your own pin lands, an empty seat appears beside it,
 * and the circle code sits underneath as the way to fill that seat.
 *
 * It deliberately does not re-list Share / Check in / SMS. The features screen
 * already introduces those; saying them twice in a four-screen flow turns the
 * payoff into a summary slide. What is new here is the map, and the one thing
 * the map cannot show on its own -- that it is empty until someone joins.
 */
function ReadyScreen({
  currentUserName: _currentUserName,
  mapPoint,
  invite,
  loading,
  error,
  copied,
  onRetry,
  onCopy,
  onShare,
  onBack,
  onSkip,
  onContinue,
  leaving,
  completeLabel,
  completing,
  settlementRetryCount,
  joinCode,
  joinPreview,
  joinBusy,
  joinError,
  joinAccepted,
  joinEnabled,
  onJoinCodeChange,
  onPreviewJoinCode,
  onAcceptJoinCode,
  onClearJoinPreview,
}: {
  currentUserName: string;
  mapPoint: { lat: number; lng: number } | null;
  invite: OnboardingCircleInvite | null;
  loading: boolean;
  error: string | null;
  copied: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onShare: () => void;
  onBack: () => void;
  onSkip: () => void;
  onContinue: () => void;
  leaving: boolean;
  completeLabel: string;
  completing: boolean;
  settlementRetryCount: number;
  joinCode: string;
  joinPreview: OnboardingCirclePreview | null;
  joinBusy: boolean;
  joinError: string | null;
  joinAccepted: boolean;
  joinEnabled: boolean;
  onJoinCodeChange: (value: string) => void;
  onPreviewJoinCode: () => void;
  onAcceptJoinCode: () => void;
  onClearJoinPreview: () => void;
}) {
  const formattedCode = invite ? formatCircleCode(invite.code) : "";

  return (
    <div
      className={READY_SURFACE_CLASSNAME}
      data-testid="one-location-onboarding-ready-surface"
    >
      {/* The map gets its own band rather than sitting behind the copy.
          A translucent scrim over a live map is a contrast gamble that depends
          on whatever streets happen to be under the text -- dense city tiles
          win, and the copy becomes unreadable. Giving the map the top third and
          the words an opaque sheet means both are always legible, and it is the
          layout every map product converges on for the same reason. */}
      <OnboardingLiveMap
        point={mapPoint}
        className={READY_MAP_CLASSNAME}
      />

      {/* Floats over the map: the controls stay reachable without stealing a
          band of the map, and both sit on their own translucent chips. */}
      {/* Same clearance, and it matters more here: the header floats over
          the map, so without it the controls sit directly under the status
          bar with map tiles behind both. */}
      <header className="absolute inset-x-0 top-0 z-20 flex min-h-16 shrink-0 items-center justify-between px-5 pb-2 pt-[max(var(--app-safe-area-top-effective,0px),8px)]">
        <button
          type="button"
          onClick={onBack}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-white/85 text-[#1f2b3d] shadow-[0_2px_10px_rgba(24,57,91,0.14)] backdrop-blur-sm dark:bg-[#1c212a]/85 dark:text-white"
          aria-label="Go back"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <span className="rounded-full bg-white/85 px-1 shadow-[0_2px_10px_rgba(24,57,91,0.14)] backdrop-blur-sm dark:bg-[#1c212a]/85">
          <OnboardingSkipButton onClick={onSkip} disabled={leaving} />
        </span>
      </header>

      <div
        className={READY_PANEL_CLASSNAME}
        data-testid="one-location-onboarding-ready-panel"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-6 md:px-7 md:pb-5 md:pt-7">
          <h1
            className="ui-text-agent-title pb-1 leading-[1.15] text-[#151b26] dark:!text-[#f5f7fb]"
            data-one-ready-title
          >
            You&apos;re on the map.
          </h1>
          <p className="mt-2 text-[15px] font-normal leading-[20px] text-[#73777f] dark:text-[#b5bfcc]">
            Private until you share.
          </p>

        <p
          className="mt-6 flex items-center gap-2 text-[14px] font-medium leading-5 text-[#5c626c] dark:text-[#aeb8c7]"
          data-testid="onboarding-ready-empty-seat"
          data-one-ready-seat
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[color:var(--app-accent)]/45">
            <UserPlus
              className="h-3.5 w-3.5 text-[color:var(--app-accent)]/70"
              strokeWidth={2.2}
            />
          </span>
          Your people show up here once they join.
        </p>

        <div
          className="mt-5 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-5 dark:border-white/[0.08] dark:bg-[#1c212a]"
          data-testid="one-location-onboarding-invite-card"
          data-one-ready-code
        >
          {loading ? (
            <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-[#777d86] dark:text-[#8d99a8]">
              <Loader2 className="h-5 w-5 animate-spin" /> Preparing your circle
              code
            </div>
          ) : error ? (
            <div className="flex min-h-24 flex-col items-center justify-center gap-3 text-center">
              <p className="max-w-[260px] text-sm leading-5 text-[#6f7580] dark:text-[#aeb8c7]">
                {error}
              </p>
              <button
                type="button"
                onClick={onRetry}
                className="press-scale inline-flex min-h-11 items-center justify-center rounded-full bg-[color:var(--app-accent)] px-5 text-sm font-bold text-[color:var(--app-accent-fg)]"
              >
                Try again
              </button>
            </div>
          ) : invite ? (
            <>
              <p className="text-[13px] font-medium leading-[18px] text-[#6E6E73] dark:text-[#aeb8c7]">
                Bring your people to {invite.circleName}
              </p>
              <p
                className="mt-2 select-all whitespace-nowrap font-mono text-[clamp(20px,6vw,28px)] font-bold uppercase leading-[1.15] tracking-[0.12em] text-[#151b26] dark:text-[#f5f7fb]"
                data-testid="one-location-onboarding-invite-code"
              >
                {formattedCode}
              </p>
              <p className="mt-2 text-[12px] leading-[18px] text-[#96999e] dark:text-[#8d99a8]">
                Expires in 72 hours. You can get a fresh one any time.
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={onCopy}
                  className="press-scale inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[#d5d9df] bg-white text-[15px] font-bold text-[#1f2b3d] dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
                >
                  {copied ? (
                    <Check className="h-5 w-5" strokeWidth={2.5} />
                  ) : (
                    <Copy className="h-5 w-5" strokeWidth={2} />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  type="button"
                  onClick={onShare}
                  className="press-scale inline-flex h-11 items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] text-[15px] font-bold text-[color:var(--app-accent-fg)]"
                >
                  <Share2 className="h-5 w-5" strokeWidth={2} />
                  Share
                </button>
              </div>
            </>
          ) : (
            <p className="flex min-h-24 items-center justify-center px-2 text-center text-sm leading-5 text-[#6f7580] dark:text-[#8d99a8]">
              Your circle code will be ready in One. You can share it any time
              from your circle.
            </p>
          )}
        </div>

        {joinEnabled ? (
          <div className="mt-4" data-testid="onboarding-join-circle">
            {joinAccepted ? (
              <p
                className="flex items-center gap-2 rounded-[20px] border border-[color:var(--app-accent)]/25 bg-[color:var(--app-accent-soft)] px-5 py-3 text-[14px] font-medium leading-5 text-[#1f2b3d] dark:text-[#dce6f5]"
                role="status"
              >
                <Check
                  className="h-4 w-4 shrink-0 text-[color:var(--app-accent)]"
                  strokeWidth={2.5}
                />
                You&apos;ll join {joinPreview?.name ?? "their circle"} as soon as
                One finishes setting up.
              </p>
            ) : joinPreview ? (
              <div
                // Same geometry as the invite card directly above it. These two
                // stack at the same width, so a 16px inset under a 20px one put
                // every line of the join card 4px left of the code card's --
                // a visibly ragged edge down the panel.
                className="rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-5 dark:border-white/[0.08] dark:bg-[#1c212a]"
                data-testid="onboarding-join-circle-preview"
              >
                {/* Name, owner and size before accepting. Deciding whether to
                    share your location with a group is not a decision anyone
                    should make against an opaque string. */}
                <p className="text-[15px] font-bold leading-5 text-[#151b26] dark:text-[#f5f7fb]">
                  {joinPreview.name}
                </p>
                <p className="mt-1 text-[13px] leading-[18px] text-[#73777f] dark:text-[#aeb8c7]">
                  {joinPreview.ownerDisplayName} &middot;{" "}
                  {joinPreview.memberCount}{" "}
                  {joinPreview.memberCount === 1 ? "person" : "people"}
                </p>
                {joinPreview.alreadyMember ? (
                  <p className="mt-3 text-[13px] leading-[18px] text-[#73777f] dark:text-[#aeb8c7]">
                    You&apos;re already in this circle.
                  </p>
                ) : (
                  <button
                    type="button"
                    onClick={onAcceptJoinCode}
                    disabled={joinBusy || leaving}
                    className="press-scale mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] text-[15px] font-bold text-[color:var(--app-accent-fg)] disabled:opacity-60"
                  >
                    {joinBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Join {joinPreview.name}
                  </button>
                )}
                {/* The only way back. Previewing replaced the input, so without
                    this a mistyped or wrong code left the person staring at
                    someone else's circle with no route to try another. */}
                <button
                  type="button"
                  onClick={onClearJoinPreview}
                  disabled={joinBusy || leaving}
                  className="press-scale mt-2 inline-flex min-h-11 w-full items-center justify-center text-[14px] font-bold text-[color:var(--app-accent-deep)] disabled:opacity-50 dark:text-[color:var(--app-accent-bright)]"
                  data-testid="onboarding-join-circle-reset"
                >
                  Use a different code
                </button>
              </div>
            ) : (
              <details className="group" data-testid="onboarding-join-circle-toggle" open={Boolean(joinCode)}>
                <summary className="flex min-h-11 cursor-pointer list-none items-center justify-center text-[14px] font-bold text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]">
                  Someone sent you a code?
                </summary>
                <div className="mt-3 flex gap-2">
                  <input
                    value={joinCode}
                    onChange={(event) => onJoinCodeChange(event.target.value)}
                    placeholder="Enter their code"
                    aria-label="Circle code"
                    autoCapitalize="characters"
                    autoCorrect="off"
                    spellCheck={false}
                    className="h-11 min-w-0 flex-1 rounded-full border border-[#d5d9df] bg-white px-4 font-mono text-[15px] uppercase tracking-[0.08em] text-[#151b26] outline-none focus:border-[color:var(--app-accent)] dark:border-white/15 dark:bg-white/[0.06] dark:text-[#f5f7fb]"
                  />
                  <button
                    type="button"
                    onClick={onPreviewJoinCode}
                    disabled={joinBusy || !joinCode.trim() || leaving}
                    className="press-scale inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-[#d5d9df] bg-white px-5 text-[15px] font-bold text-[#1f2b3d] disabled:opacity-50 dark:border-white/15 dark:bg-white/[0.06] dark:text-white"
                  >
                    {joinBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : null}
                    Look up
                  </button>
                </div>
              </details>
            )}
            {joinError ? (
              <p
                className="mt-2 text-center text-[13px] leading-[18px] text-[#c8372d] dark:text-[#ff9a90]"
                role="status"
              >
                {joinError}
              </p>
            ) : null}
          </div>
        ) : null}
        </div>

        {/* The SAME surface as the panel it sits inside, by token rather than
            by a second hand-picked hex. When the panel moved to the semantic
            token and this did not, dark mode showed the panel at #1c1c1e and
            its own footer at #14171d -- one card with a seam across it. */}
        <footer className="relative z-10 shrink-0 bg-[color:var(--app-primary-surface)] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-3 md:px-7 md:pb-7">
          {settlementRetryCount > 0 ? (
            <p
              className="mb-3 text-center text-[13px] leading-5 text-[#96999e] dark:text-[#8d99a8]"
              role="status"
            >
              That didn&apos;t save. Tap again to finish setting up Location.
            </p>
          ) : null}
          {/* Always the completion CTA. A code that failed to load is not a
              reason to record the whole capability as skipped -- the person
              granted permission and saved a place, so finishing is the honest
              outcome. Retrying the code lives inside the card above. */}
          <PrimaryButton onClick={onContinue} busy={completing} disabled={leaving}>
            {completeLabel}
          </PrimaryButton>
        </footer>
      </div>

      <style>{`
        [data-one-ready-title] { animation: oneReadyRise 520ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        [data-one-ready-seat] { animation: oneReadyRise 520ms cubic-bezier(0.22, 1, 0.36, 1) both; animation-delay: 80ms; }
        [data-one-ready-code] { animation: oneReadyRise 560ms cubic-bezier(0.22, 1, 0.36, 1) both; animation-delay: 140ms; }
        /* 34dvh of map is right on a phone, which is tall. A 1366x768 laptop is
           shorter than an iPhone, and there the same fraction pushed the join
           link below the fold -- so the last thing on the screen needed a
           scroll to discover it existed. The map yields the height instead,
           since it is atmosphere and the link is a way in. Phones are past 820px
           and keep the taller band. */
        @media (max-width: 767px) and (max-height: 820px) {
          [data-testid="onboarding-live-map"] { height: 24dvh; min-height: 150px; }
        }
        @keyframes oneReadyRise {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-one-ready-title],
          [data-one-ready-seat],
          [data-one-ready-code] {
            animation: none;
            opacity: 1;
            transform: none;
          }
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
  locationPermission,
  notificationDeliveryMode,
  notificationBusy,
  locationBusy,
  nativeTest,
  onRequestLocation,
  onLocationReady,
  onRequestNotifications,
  onBack,
  onComplete,
  onSkip = onComplete,
  requireLocationToComplete = false,
  completeLabel = "Open One Location",
  mapPoint = null,
  contactsStepAvailable = true,
  onSyncOnboardingContacts,
  onAddOnboardingContact,
  onOpenContactSettings,
  onPreviewCircleCode,
  onAcceptCircleCode,
  onPrepareOnboardingCircleInvite,
  onCopyOnboardingCircleCode,
  onShareOnboardingCircleCode,
}: OneLocationOnboardingFlowProps) {
  for (const source of ONBOARDING_IMAGE_SOURCES) {
    preload(source, { as: "image", fetchPriority: "high" });
  }

  // The finale is a map, and a map that arrives after the screen does reads as
  // the product being slow at the exact moment it is trying to impress. Warm
  // the connection from the very first screen so DNS and TLS are already paid
  // for, then start the Maps script immediately -- the loader is a module-level
  // singleton, so this is the same request the finale would make, only several
  // screens earlier and off the critical path.
  preconnect("https://maps.googleapis.com");
  preconnect("https://maps.gstatic.com");
  useGoogleMaps({ enabled: true });

  const [screen, setScreen] = useState<OnboardingScreen>(() =>
    initialScreen(startAt),
  );
  // Invite screen (final step) state. The parent provisions the code; we cache
  // it so navigating back/forward never refetches or rotates it.
  const [circleInvite, setCircleInvite] =
    useState<OnboardingCircleInvite | null>(null);
  const [circleInviteLoading, setCircleInviteLoading] = useState(false);
  const [circleInviteError, setCircleInviteError] = useState<string | null>(
    null,
  );
  const [circleInviteCopied, setCircleInviteCopied] = useState(false);
  const circleInvitePreparedRef = useRef(false);
  const circleInviteInFlightRef = useRef(false);
  const circleInviteCopiedTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  // Contacts screen. Nothing runs until the person asks for it, so "idle" is
  // the resting state rather than a loading one.
  const [contactState, setContactState] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "none"; partial: boolean }
    | { kind: "matched" }
    | { kind: "failed"; message: string; canOpenSettings: boolean }
  >({ kind: "idle" });
  const [contactMatches, setContactMatches] = useState<OnboardingContactMatch[]>(
    [],
  );
  const [addedContactIds, setAddedContactIds] = useState<string[]>([]);
  const [addingContactIds, setAddingContactIds] = useState<string[]>([]);

  // "Someone sent me a code" is the other half of this product, and it had no
  // route through onboarding at all: a person handed a code finished setup
  // alone and then had to go hunting for Join a circle on the hub.
  const [joinCode, setJoinCode] = useState("");
  const [joinPreview, setJoinPreview] =
    useState<OnboardingCirclePreview | null>(null);
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinAccepted, setJoinAccepted] = useState(false);

  const [leaving, setLeaving] = useState(false);
  const [completionBusy, setCompletionBusy] = useState(false);
  const [settlementRetryCount, setSettlementRetryCount] = useState(0);
  const permissionPromptAttemptedRef = useRef(false);
  // Set on the tap, not on the answer. `locationPermission` is a prop the
  // parent refreshes asynchronously, and on the web it can sit at "prompt"
  // for a while after the browser dialog closes — so without this the CTA
  // would keep offering to ask for something already asked.
  const [locationAsked, setLocationAsked] = useState(false);
  // Funnel bookkeeping. Refs, not state: none of this should cause a render.
  const codeSharedRef = useRef(false);
  const codeCopiedRef = useRef(false);
  const outcomeReportedRef = useRef(false);
  const screensSeenRef = useRef<Set<OnboardingScreen>>(new Set());
  const locationPreparationCompleteRef = useRef(false);
  const locationPreparationInFlightRef = useRef<Promise<boolean> | null>(null);
  const completionInFlightRef = useRef(false);
  const [locationPreparationBusy, setLocationPreparationBusy] = useState(false);
  const [locationPreparationRetry, setLocationPreparationRetry] =
    useState(false);

  const locationGranted =
    locationPermission?.state === "granted" &&
    locationPermission.locationServicesEnabled !== false;
  // "Blocked" is the state where asking again cannot help: refused, held by
  // device policy, or the phone's Location Services switch is off. `prompt`
  // and a null (not yet read) permission are NOT blocked — those are exactly
  // the states where the primer's Allow button still has something to do.
  const locationBlocked =
    locationPermission?.state === "denied" ||
    locationPermission?.state === "restricted" ||
    locationPermission?.locationServicesEnabled === false;
  const notificationsGranted = notificationDeliveryMode === "push_active";

  /*
   * Only ever called from an explicit tap on step two's "Allow location"
   * (#5395). It used to run on the same tick as the navigation into that
   * screen, and on mount for the `startAt: "permissions"` entry.
   *
   * The two asks are also SEQUENCED now, not raced. `Promise.allSettled`
   * over both handlers put two native alerts on screen at once, and the
   * second one covered the first — so the person answered a notifications
   * prompt believing it was the location prompt they had just asked for.
   * Notifications wait until Location has settled, whichever way it went.
   */
  const requestMissingPermissions = useCallback(async () => {
    if (permissionPromptAttemptedRef.current) return;
    permissionPromptAttemptedRef.current = true;
    if (!locationGranted) {
      try {
        await onRequestLocation();
      } catch {
        // The parent owns the toast; the screen reads the resulting
        // permission state rather than narrating its own failure.
      }
    }
    if (!notificationsGranted) {
      try {
        await onRequestNotifications();
      } catch {
        // Same: never block the flow on the secondary ask.
      }
    }
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

  // The `startAt: "permissions"` entry lands on the same step-two screen and
  // gets the same primer. It used to fire both native dialogs from this
  // effect with no interaction at all — the worst version of #5395, since
  // the person had not even tapped "Get started" first.

  useEffect(() => {
    if (screen !== "features" || !locationGranted) return;
    void prepareSavedLocation();
  }, [locationGranted, prepareSavedLocation, screen]);

  const prepareCircleInvite = useCallback(async () => {
    if (!onPrepareOnboardingCircleInvite) return;
    if (circleInviteInFlightRef.current) return;
    circleInviteInFlightRef.current = true;
    setCircleInviteLoading(true);
    setCircleInviteError(null);
    try {
      const prepared = await onPrepareOnboardingCircleInvite();
      circleInvitePreparedRef.current = true;
      setCircleInvite(prepared);
    } catch (error) {
      setCircleInvite(null);
      setCircleInviteError(
        error instanceof Error && error.message
          ? error.message
          : "We couldn't prepare your circle code. Try again.",
      );
    } finally {
      circleInviteInFlightRef.current = false;
      setCircleInviteLoading(false);
    }
  }, [onPrepareOnboardingCircleInvite]);

  // Provision the invite code once, the first time the Invite screen opens.
  useEffect(() => {
    screensSeenRef.current.add(screen);
  }, [screen]);

  useEffect(() => {
    if (screen !== "invite") return;
    if (circleInvitePreparedRef.current || circleInviteInFlightRef.current) {
      return;
    }
    void prepareCircleInvite();
  }, [prepareCircleInvite, screen]);

  useEffect(() => {
    return () => {
      if (circleInviteCopiedTimerRef.current) {
        clearTimeout(circleInviteCopiedTimerRef.current);
      }
    };
  }, []);

  const handleCopyCircleInvite = useCallback(() => {
    if (!circleInvite) return;
    codeCopiedRef.current = true;
    void Promise.resolve(
      onCopyOnboardingCircleCode?.(circleInvite.code),
    ).catch(() => {
      /* parent surfaces its own failure toast */
    });
    setCircleInviteCopied(true);
    if (circleInviteCopiedTimerRef.current) {
      clearTimeout(circleInviteCopiedTimerRef.current);
    }
    circleInviteCopiedTimerRef.current = setTimeout(
      () => setCircleInviteCopied(false),
      2000,
    );
  }, [circleInvite, onCopyOnboardingCircleCode]);

  const handleShareCircleInvite = useCallback(() => {
    if (!circleInvite) return;
    codeSharedRef.current = true;
    void Promise.resolve(
      onShareOnboardingCircleCode?.(circleInvite),
    ).catch(() => {
      /* parent surfaces its own failure toast */
    });
  }, [circleInvite, onShareOnboardingCircleCode]);

  const handleSyncContacts = useCallback(async () => {
    if (!onSyncOnboardingContacts) return;
    setContactState({ kind: "busy" });
    try {
      const result = await onSyncOnboardingContacts();
      if (result.status === "matched" && result.matches.length > 0) {
        setContactMatches(result.matches);
        setContactState({ kind: "matched" });
        return;
      }
      // A declined permission resolves rather than throws, and must not be
      // reported as "nobody matched" -- that would hide the one thing that
      // could fix it, and on iOS the decline is otherwise permanent.
      if (result.status === "failed") {
        setContactState({
          kind: "failed",
          message: result.message,
          canOpenSettings:
            result.canOpenSettings && Boolean(onOpenContactSettings),
        });
        return;
      }
      // "matched" with an empty list lands here too, which is the same outcome
      // as "none" from the person's point of view.
      setContactState({
        kind: "none",
        partial: result.status === "none" ? result.partial : false,
      });
    } catch (error) {
      setContactState({
        kind: "failed",
        message:
          error instanceof Error && error.message
            ? error.message
            : "We couldn't check your contacts. You can try again later.",
        canOpenSettings: Boolean(onOpenContactSettings),
      });
    }
  }, [onOpenContactSettings, onSyncOnboardingContacts]);

  const handleAddContact = useCallback(
    (userId: string) => {
      if (!onAddOnboardingContact) return;
      setAddingContactIds((current) =>
        current.includes(userId) ? current : [...current, userId],
      );
      void Promise.resolve(onAddOnboardingContact(userId))
        .then(() => {
          setAddedContactIds((current) =>
            current.includes(userId) ? current : [...current, userId],
          );
        })
        .catch(() => {
          /* the parent owns the failure toast; the row simply stays addable */
        })
        .finally(() => {
          setAddingContactIds((current) =>
            current.filter((id) => id !== userId),
          );
        });
    },
    [onAddOnboardingContact],
  );

  const handlePreviewJoinCode = useCallback(async () => {
    if (!onPreviewCircleCode) return;
    const trimmed = joinCode.trim();
    if (!trimmed) return;
    // Your own code resolves to a circle you already own, so the generic
    // "you're already in this circle" would be technically true and useless.
    // Caught before the request, because there is nothing to look up.
    if (
      circleInvite &&
      normalizeCircleCode(trimmed) === normalizeCircleCode(circleInvite.code)
    ) {
      setJoinPreview(null);
      setJoinError(
        "That's your own code — send it to someone else so they can join you.",
      );
      return;
    }
    setJoinBusy(true);
    setJoinError(null);
    try {
      setJoinPreview(await onPreviewCircleCode(trimmed));
    } catch (error) {
      setJoinPreview(null);
      setJoinError(
        error instanceof Error && error.message
          ? error.message
          : "That code did not match a circle. Check it and try again.",
      );
    } finally {
      setJoinBusy(false);
    }
  }, [circleInvite, joinCode, onPreviewCircleCode]);

  const handleAcceptJoinCode = useCallback(async () => {
    if (!onAcceptCircleCode || !joinPreview) return;
    setJoinBusy(true);
    setJoinError(null);
    try {
      await onAcceptCircleCode(joinCode.trim());
      setJoinAccepted(true);
    } catch (error) {
      setJoinError(
        error instanceof Error && error.message
          ? error.message
          : "We couldn't join that circle. You can try again from Circles.",
      );
    } finally {
      setJoinBusy(false);
    }
  }, [joinCode, joinPreview, onAcceptCircleCode]);

  // Report how onboarding ended, once per exit. Removing the contact picker is
  // a bet on drop-off; without this there is no way to tell whether it paid off
  // or simply moved where people leave. The circle code is deliberately never
  // included -- this screen's whole content is a shareable secret.
  const reportOutcome = useCallback(
    (exitedVia: "complete" | "skip") => {
      if (outcomeReportedRef.current) return;
      outcomeReportedRef.current = true;
      trackEvent("one_location_onboarding_completed", {
        route_id: resolveRouteId(window.location.pathname),
        result: "success",
        exited_via: exitedVia,
        code_shared: codeSharedRef.current,
        code_copied: codeCopiedRef.current,
        screens_seen: screensSeenRef.current.size,
        contacts_matched: contactMatches.length,
        contacts_added: addedContactIds.length,
      });
      // Only a finish counts as a funnel step. A skip is a real exit and is
      // still legible on the feature event above via `exited_via`; folding it
      // in here would flatter the funnel and hide the drop.
      if (exitedVia === "complete") {
        trackLocationFunnelStepCompleted("onboarding_completed");
      }
    },
    [addedContactIds.length, contactMatches.length],
  );

  // Paired with the step above so the ratio between them is the onboarding
  // drop-off rate.
  useEffect(() => {
    trackLocationFunnelStepCompleted("onboarding_started");
  }, []);

  // Completion is a press, not a timer. The settlement guard and retry counter
  // are unchanged -- they are what makes setup completion durable when the
  // capability coordinator rejects -- but a screen that finished itself after
  // four seconds could not be skipped, could not be tested by the reviewer
  // flow, and made the person wait for nothing.
  const finishFromInvite = useCallback(() => {
    if (completionInFlightRef.current || leaving) return;
    completionInFlightRef.current = true;
    setCompletionBusy(true);
    reportOutcome("complete");
    void Promise.resolve(onComplete()).then(
      () => {
        // Only on settle. `reportOutcome` above fires when the button is
        // pressed; this fires when setup actually took, and setup is a one-time
        // lock — the two diverge exactly when settlement is failing, which is
        // the case worth seeing.
        trackEvent("one_location_setup_completed", {
          route_id: resolveRouteId(window.location.pathname),
          result: "success",
          settlement_retries: settlementRetryCount,
        });
      },
      () => {
        completionInFlightRef.current = false;
        setCompletionBusy(false);
        setSettlementRetryCount((current) => current + 1);
      },
    );
  }, [leaving, onComplete, reportOutcome, settlementRetryCount]);

  const runSkip = async (settleCircle = false) => {
    if (leaving || (settleCircle && completionInFlightRef.current)) return;
    if (settleCircle) {
      completionInFlightRef.current = true;
      setCompletionBusy(true);
    }
    setLeaving(true);
    reportOutcome("skip");
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

  // Navigation only. The permission ask now belongs to step two's own CTA.
  const openFeatures = () => {
    setScreen("features");
  };

  const allowLocationFromFeatures = () => {
    setLocationAsked(true);
    void requestMissingPermissions();
  };

  /*
   * A refused device is only fixable in the OS. The parent's own handler is
   * what knows how to get there — on native it opens app settings, on the web
   * it toasts the site-settings instructions — so this re-enters through the
   * same door rather than duplicating that knowledge here. Deliberately NOT
   * behind `permissionPromptAttemptedRef`: this is a repeatable recovery
   * action, not the one-shot first ask.
   */
  const openLocationSettingsFromFeatures = () => {
    void Promise.resolve(onRequestLocation()).catch(() => {
      // The parent owns the message; the screen reads the resulting state.
    });
  };

  const backFromFeatures = () => {
    // A dismissed location picker is reversible. When the owner goes back and
    // returns to Features, prepare Location again; the parent still suppresses
    // duplicate work after a confirmed save.
    locationPreparationCompleteRef.current = false;
    if (startAt === "permissions") {
      void runBack();
      return;
    }
    setScreen("welcome");
  };

  const continueFromFeatures = () => {
    if (requireLocationToComplete && !locationGranted) {
      // Mandatory-Location callers keep re-asking. On a refused device the
      // OS will not re-show the alert, and the parent's handler is what
      // routes the person to Settings.
      void onRequestLocation();
      return;
    }
    if (locationGranted && !locationPreparationCompleteRef.current) {
      void prepareSavedLocation();
      return;
    }
    setScreen(contactsStepAvailable ? "contacts" : "invite");
  };


  return (
    <main
      // z-560, above the agent bar's elevated z-540. The bar normally sits at
      // z-118 and onboarding covered it, but it raises itself to 540 for a
      // pending confirmation or an interactive voice layer -- at which point it
      // tied with this overlay and won on DOM order, drawing "Talk to One"
      // across the primary CTA. Onboarding is modal; nothing belongs over it.
      className="fixed inset-0 z-[560] flex h-dvh min-h-[100svh] w-full items-stretch justify-center overflow-hidden bg-[#eef3f8] text-[#171d28] dark:bg-[#070a0f] dark:text-[#f4f7fb]"
      data-no-route-swipe
      data-testid="one-location-onboarding"
      data-location-onboarding-screen={screen}
    >
      <NativeTestBeacon {...nativeTest} />
      <section
        className={cn(
          "flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[#0c1017]",
          // The welcome and feature screens own the full-bleed desktop canvas,
          // while their inner content rails keep the designed width. Expanding
          // the canvas is fine; stretching feature cards is what creates the
          // broken desktop collisions. Dense later steps keep the phone-width
          // flow.
          //
          // The feature cards style themselves with `@container (max-width:
          // 420px)`, so the CARD decides its own tier, not the viewport. At a
          // 480px panel the card measured 432px and fell out of that tier, so
          // desktop rendered a different pill size, padding and type scale than
          // the same screen on a phone -- which is the inconsistency, not any
          // single element being misplaced. 430px puts the card at 382px, in
          // the same tier a phone lands in, so the two render identically.
          //
          // 431px is the phone breakpoint: below it the panel goes full-bleed
          // rather than leaving side gutters on a device that has none.
          screen === "welcome"
            ? "max-w-none"
            : screen === "features" || screen === "invite"
              ? "max-w-none"
            : "max-w-[430px] max-[431px]:max-w-none",
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
            locationBlocked={locationBlocked}
            locationAsked={locationAsked}
            locationBusy={locationBusy}
            locationPreparationBusy={locationPreparationBusy}
            locationPreparationRetry={locationPreparationRetry}
            notificationBusy={notificationBusy}
            requireLocationToContinue={requireLocationToComplete}
            onBack={backFromFeatures}
            onSkip={() => void runSkip()}
            leaving={leaving}
            onAllowLocation={allowLocationFromFeatures}
            onOpenLocationSettings={openLocationSettingsFromFeatures}
            onContinue={continueFromFeatures}
          />
        ) : null}
        {/* Tile prewarm. The script being ready is only half of it -- the map
            still has to fetch imagery for this exact point, and doing that on
            arrival is what makes the finale look like it is thinking. A
            full-size instance renders here, invisibly, so the tiles are in the
            browser cache before the screen that shows them exists. It unmounts
            as the finale mounts, so there is never a second live map. */}
        {screen === "contacts" && mapPoint ? (
          <OnboardingLiveMap
            point={mapPoint}
            className="pointer-events-none absolute inset-0 -z-10 opacity-0"
          />
        ) : null}
        {screen === "contacts" ? (
          <ContactsScreen
            state={contactState}
            matches={contactMatches}
            addedUserIds={addedContactIds}
            addingUserIds={addingContactIds}
            onSync={() => void handleSyncContacts()}
            onAdd={handleAddContact}
            onOpenSettings={() => onOpenContactSettings?.()}
            onBack={() => setScreen("features")}
            onSkip={() => void runSkip()}
            onContinue={() => setScreen("invite")}
            leaving={leaving}
          />
        ) : null}
        {screen === "invite" ? (
          <ReadyScreen
            currentUserName={currentUserName}
            mapPoint={mapPoint}
            invite={circleInvite}
            loading={circleInviteLoading}
            error={circleInviteError}
            copied={circleInviteCopied}
            onRetry={() => void prepareCircleInvite()}
            onCopy={handleCopyCircleInvite}
            onShare={handleShareCircleInvite}
            onBack={() =>
              setScreen(contactsStepAvailable ? "contacts" : "features")
            }
            onSkip={() => void runSkip()}
            onContinue={finishFromInvite}
            leaving={leaving}
            completeLabel={completeLabel}
            completing={completionBusy}
            settlementRetryCount={settlementRetryCount}
            joinCode={joinCode}
            joinPreview={joinPreview}
            joinBusy={joinBusy}
            joinError={joinError}
            joinAccepted={joinAccepted}
            joinEnabled={Boolean(onPreviewCircleCode && onAcceptCircleCode)}
            onJoinCodeChange={(value) => {
              setJoinCode(value);
              setJoinPreview(null);
              setJoinError(null);
            }}
            onPreviewJoinCode={() => void handlePreviewJoinCode()}
            onAcceptJoinCode={() => void handleAcceptJoinCode()}
            onClearJoinPreview={() => {
              // Keep the typed code so a single wrong character is a quick
              // edit rather than a retype of all twelve.
              setJoinPreview(null);
              setJoinError(null);
            }}
          />
        ) : null}
      </section>
    </main>
  );
}
