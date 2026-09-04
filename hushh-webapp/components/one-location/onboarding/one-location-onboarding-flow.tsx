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
  ChevronDown,
  Copy,
  Loader2,
  MapPin,
  Share2,
  UserPlus,
} from "lucide-react";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { ContactSourceBadge } from "@/components/connections/contact-source-badge";
import { OnboardingLiveMap } from "@/components/one-location/onboarding/onboarding-live-map";
import {
  ONE_LOCATION_ONBOARDING_STEPS,
  type OneLocationOnboardingScreen,
} from "@/components/one-location/onboarding/one-location-onboarding-steps";
import {
  READY_CODE_CLASSNAME,
  READY_MAP_CLASSNAME,
  READY_MAP_SHORT_WINDOW_CSS,
  READY_PANEL_CLASSNAME,
  READY_SURFACE_CLASSNAME,
} from "@/components/one-location/onboarding/ready-panel-layout";
import { resolveOnboardingFinaleMapPoint } from "@/lib/one-location/onboarding-map-point";
import { normalizeCircleCode } from "@/lib/one-location/pending-circle-join";
import { useCurrentLocation } from "@/lib/one-location/use-current-location";
import { useGoogleMaps } from "@/lib/one-location/use-google-maps";
import type { HushhLocationPermissionState } from "@/lib/capacitor";
import locationOnboardingContract from "@/lib/onboarding/one-location-onboarding.contract.json";
import { trackEvent } from "@/lib/observability/client";
import { trackLocationFunnelStepCompleted } from "@/lib/observability/growth";
import { resolveRouteId } from "@/lib/observability/route-map";
import { cn } from "@/lib/utils";

type OnboardingScreen = OneLocationOnboardingScreen;

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
 * that was every Hushh user, so it asked a new person to share location
 * with strangers. These are people whose number is already in their phone.
 */
export type OnboardingContactMatch = {
  userId: string;
  displayName: string;
  connectionStatus: "connected" | "request_required" | "suppressed";
};

/**
 * What a circle code points at, shown before anyone joins it.
 *
 * Seeing the circle's name, its owner and how many people are already in it is
 * the difference between accepting an invitation and accepting a string. It is
 * also the moment where someone decides whether to share location with
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
  | { status: "cancelled" }
  | { status: "failed"; message: string; canOpenSettings: boolean };

type OneLocationOnboardingFlowProps = {
  startAt: OneLocationOnboardingStart;
  /** Controlled screen used by the page so the sibling save-place modal can advance the flow. */
  activeScreen?: OnboardingScreen;
  onScreenChange?: (screen: OnboardingScreen) => void;
  currentUserName: string;
  locationPermission: HushhLocationPermissionState | null;
  locationBusy: boolean;
  nativeTest: React.ComponentProps<typeof NativeTestBeacon>;
  onRequestLocation: () => Promise<boolean | void>;
  onLocationReady: () => Promise<boolean>;
  onBack: () => void | Promise<void>;
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
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
  /** Account-backed web fallback versus the device address book. */
  contactsSource?: "device" | "google";
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
  plain = false,
}: {
  onClick: () => void;
  disabled?: boolean;
  inverse?: boolean;
  floating?: boolean;
  plain?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "min-h-11 rounded-full text-[16px] font-bold disabled:opacity-50",
        plain
          ? "px-2 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]"
          : floating
            ? "h-11 bg-[#eef1f5] px-5 text-[color:var(--app-accent-deep)] shadow-[0_4px_14px_rgba(26,42,65,0.14)] ring-1 ring-black/[0.06] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-accent-bright)] dark:shadow-none dark:ring-[color:var(--app-separator)]"
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
  currentStep,
  disabled = false,
  inverse = false,
  floating = false,
  plain = false,
  busy = false,
  className,
}: {
  onBack: () => void;
  onSkip?: () => void;
  currentStep: number;
  disabled?: boolean;
  inverse?: boolean;
  floating?: boolean;
  plain?: boolean;
  busy?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative z-40 grid h-16 shrink-0 grid-cols-[minmax(64px,1fr)_minmax(120px,220px)_minmax(64px,1fr)] items-center gap-2",
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
          plain
            ? "text-[#59616c] dark:text-[color:var(--app-label)]"
            : floating
              ? "bg-[#eef1f5] text-[#59616c] shadow-[0_4px_14px_rgba(26,42,65,0.14)] ring-1 ring-black/[0.06] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)] dark:shadow-none dark:ring-[color:var(--app-separator)]"
              : inverse
                ? "bg-white/15 text-white"
                : "bg-black/[0.05] text-[#1f2b3d] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]",
        )}
        aria-label="Go back"
      >
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <ArrowLeft className="h-6 w-6" aria-hidden="true" />
        )}
      </button>
      <OnboardingStepper
        steps={ONE_LOCATION_ONBOARDING_STEPS}
        currentIndex={currentStep}
        compact
        inverse={inverse}
        ariaLabel="One Location setup progress"
        className="w-full"
      />
      {onSkip ? (
        <OnboardingSkipButton
          inverse={inverse}
          floating={floating}
          plain={plain}
          onClick={onSkip}
          disabled={disabled}
        />
      ) : (
        <span className="h-11 w-11 justify-self-end" aria-hidden />
      )}
    </div>
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
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#087ff5] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-[max(var(--app-safe-area-top-effective,0px),10px)] text-white dark:bg-[#073d78]">
      <span className="pointer-events-none absolute -right-24 -top-32 h-72 w-72 rounded-full bg-white/[0.05]" />
      <span className="pointer-events-none absolute -bottom-28 -left-32 h-72 w-72 rounded-full bg-[#006bd9]/55" />
      <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-[700px] flex-1 flex-col">
        <OnboardingNavigation
          inverse
          currentStep={0}
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
              Location
            </p>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="mx-auto mt-5 max-w-[410px] text-[28px] font-bold leading-[34px] tracking-[-0.015em] outline-none"
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
        className="fill-[#edf1f6] dark:fill-[color:var(--app-secondary-surface)]"
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
        className="fill-[#e4e9f0] dark:fill-[color:var(--app-neutral-fill-strong)]"
      />
      <rect
        x="150"
        y="8"
        width="52"
        height="34"
        rx="4"
        className="fill-[#e4e9f0] dark:fill-[color:var(--app-neutral-fill-strong)]"
      />
      <rect
        x="8"
        y="118"
        width="44"
        height="48"
        rx="5"
        className="fill-[#e4e9f0] dark:fill-[color:var(--app-neutral-fill-strong)]"
      />
      {/* road casings */}
      <path
        d="M-12 86 H212"
        className="stroke-white dark:stroke-[color:var(--app-primary-surface)]"
        strokeWidth="15"
        fill="none"
      />
      <path
        d="M100 -12 V180"
        className="stroke-white dark:stroke-[color:var(--app-primary-surface)]"
        strokeWidth="15"
        fill="none"
      />
      <path
        d="M150 58 L214 122"
        className="stroke-white dark:stroke-[color:var(--app-primary-surface)]"
        strokeWidth="10"
        fill="none"
      />
      {/* road centre hairlines */}
      <path
        d="M-12 86 H212"
        className="stroke-[#dde3ec] dark:stroke-[color:var(--app-separator)]"
        strokeWidth="1.5"
        fill="none"
      />
      <path
        d="M100 -12 V180"
        className="stroke-[#dde3ec] dark:stroke-[color:var(--app-separator)]"
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
        "font-bold leading-[1.13] tracking-[-0.015em] text-[#111823] dark:text-[color:var(--app-label)]",
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
      className="relative flex aspect-[1.56/1] w-full flex-col overflow-hidden rounded-[26px] bg-[color:var(--app-primary-surface)] [container-type:inline-size]"
      data-testid="location-use-case-trip"
      data-one-use-case-card
      data-one-feature-card="share"
    >
      <MapBackdrop tone="share" />
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[color:var(--app-primary-surface)] from-[35%] via-[color:var(--app-primary-surface)] via-[51%] to-transparent" />
      <div className="relative z-20 w-[56%] px-5 pt-5" data-one-feature-copy>
        <span
          className="inline-flex rounded-full bg-[color:var(--app-accent-tint)] px-3 py-1 text-[11px] font-bold text-[color:var(--app-accent-deep)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]"
          data-one-use-case-tag
        >
          Share location
        </span>
        <TwoLineFeatureTitle
          lines={["Can’t explain", "where you are?"]}
          className="font-[family-name:var(--font-app-display)] text-[21px]"
        />
        <p
          className="text-[15px] leading-[1.4] text-[#747b86] dark:text-[color:var(--app-secondary-label)]"
          data-one-feature-body
        >
          Share your live location with your Circle in one tap.
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
        <span className="absolute left-[47%] top-[49%] h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-white bg-[color:var(--app-accent)] shadow-[0_3px_10px_rgba(8,127,245,0.28)] dark:border-[color:var(--app-primary-surface)] dark:shadow-none" />
        {SHARE_LOCATION_AVATARS.map((avatar, index) => (
          <span
            key={avatar.src}
            className={cn(
              "absolute h-11 w-11 overflow-hidden rounded-full border-[3px] border-white bg-white shadow-[0_5px_14px_rgba(24,57,91,0.2)] dark:border-[color:var(--app-primary-surface)] dark:bg-[color:var(--app-secondary-surface)] dark:shadow-none",
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
    </article>
  );
}

function CheckInFeatureCard() {
  return (
    <article
      className="relative flex aspect-[0.68/1] w-full flex-col overflow-hidden rounded-[26px] bg-[color:var(--app-primary-surface)] [container-type:inline-size]"
      data-testid="location-use-case-checkin"
      data-one-use-case-card
      data-one-feature-card="checkin"
    >
      <div
        className="relative z-20 bg-gradient-to-b from-[color:var(--app-primary-surface)] via-[color:var(--app-primary-surface)] to-[color:var(--app-primary-surface)]/90 px-4 pb-2 pt-4"
        data-one-feature-copy
      >
        <span
          className="inline-flex rounded-full bg-[#dff4e7] px-3 py-1 text-[11px] font-bold text-[#27884f] dark:bg-[color:var(--app-success-surface)] dark:text-[color:var(--app-success-bright)]"
          data-one-use-case-tag
        >
          Check in
        </span>
        <TwoLineFeatureTitle
          lines={["Stuck waiting", "in line?"]}
          className="text-[19px]"
        />
        <p
          className="text-[14px] leading-[1.4] text-[#747b86] dark:text-[color:var(--app-secondary-label)]"
          data-one-feature-body
        >
          Check in on the spot and notify your circle
        </p>
      </div>
      <div
        className="absolute inset-0"
        data-one-checkin-map-backdrop
        aria-hidden="true"
      >
        <MapBackdrop tone="checkin" />
      </div>
      <span
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[68%] bg-gradient-to-b from-[color:var(--app-primary-surface)] via-[color:var(--app-primary-surface)] to-transparent"
        aria-hidden="true"
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[46%]"
        data-one-use-case-art
        aria-hidden="true"
      >
        <span className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-[color:var(--app-primary-surface)] via-[color:var(--app-primary-surface)]/85 to-transparent" />
        <span
          className="absolute bottom-[18%] left-1/2 flex h-[64px] w-[64px] -translate-x-1/2 items-center justify-center rounded-full bg-white/90 shadow-[0_8px_22px_rgba(24,57,91,0.16)] ring-1 ring-white/80 dark:bg-[color:var(--app-secondary-surface)] dark:shadow-none dark:ring-[color:var(--app-separator)]"
          data-one-checkin-destination
        >
          <MapPin
            className="h-9 w-9 text-[color:var(--app-accent)]"
            strokeWidth={2.4}
          />
          <span
            className="absolute -right-1 -top-1 flex h-6 w-6 items-center justify-center rounded-full bg-[color:var(--app-success)] text-white ring-[3px] ring-white dark:ring-[color:var(--app-secondary-surface)]"
            data-one-checkin-illustration
          >
            <Check className="h-3.5 w-3.5" strokeWidth={3.2} />
          </span>
        </span>
      </div>
    </article>
  );
}

function SaveMySoulFeatureCard() {
  return (
    <article
      className="relative flex aspect-[0.68/1] w-full flex-col overflow-hidden rounded-[26px] bg-[color:var(--app-primary-surface)] [container-type:inline-size]"
      data-testid="location-use-case-sos"
      data-one-use-case-card
      data-one-feature-card="sms"
    >
      <div className="relative z-20 px-4 pt-4" data-one-feature-copy>
        <span
          className="inline-flex rounded-full bg-[#ffe0df] px-3 py-1 text-[11px] font-bold text-[#d44442] dark:bg-[color:var(--app-destructive-surface)] dark:text-[color:var(--app-destructive-bright)]"
          data-one-use-case-tag
        >
          SMS · Save My Soul
        </span>
        <TwoLineFeatureTitle
          lines={["Need help but", "can’t talk?"]}
          className="text-[19px]"
        />
        <p
          className="text-[14px] leading-[1.4] text-[#747b86] dark:text-[color:var(--app-secondary-label)]"
          data-one-feature-body
        >
          Send an SMS with your location in seconds.
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
              className="absolute inset-0 rounded-full border-2 border-[#ff3b30]/30 bg-[#ff3b30]/[0.08] [animation:oneSmsRadar_2.4s_ease-out_infinite]"
            />
            <span
              data-one-onboarding-motion
              data-one-sms-radar-ring
              className="absolute inset-[10px] rounded-full border-2 border-[#ff3b30]/25 bg-[#ff3b30]/[0.08] [animation:oneSmsRadar_2.4s_ease-out_infinite] [animation-delay:1.2s]"
            />
            <span
              data-one-sms-core
              className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-[#ff3b30] text-[15px] font-bold text-white shadow-[0_12px_22px_rgba(255,59,48,0.28)] dark:shadow-none"
            >
              <span className="relative z-10" data-one-sms-label>
                SMS
              </span>
            </span>
          </span>
        </div>
      </div>
    </article>
  );
}

function FeaturesScreen({
  locationGranted,
  locationBlocked,
  locationBusy,
  locationPreparationBusy,
  locationPreparationRetry,
  onBack,
  onSkip,
  leaving,
  onContinue,
}: {
  locationGranted: boolean;
  locationBlocked: boolean;
  locationBusy: boolean;
  locationPreparationBusy: boolean;
  locationPreparationRetry: boolean;
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
  onContinue: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const permissionBusy = locationBusy || locationPreparationBusy;
  const status = locationPreparationBusy
    ? "Finding your location…"
    : locationBusy
      ? "Requesting Location…"
      : locationPreparationRetry
        ? "We couldn't find your location. Check access and try again."
        : locationBlocked
          ? "Location access is off. Turn it on to set up One Location."
          : locationGranted
            ? "Location is ready. Your next tap opens the place picker."
            : "Your location stays private until you share.";

  return (
    <div
      className="relative z-50 pointer-events-auto mx-auto flex h-full min-h-0 w-full max-w-[430px] max-[431px]:max-w-none flex-1 flex-col overflow-hidden bg-[color:var(--app-grouped-background)] px-5 pb-[max(env(safe-area-inset-bottom,0px),18px)] pt-[max(var(--app-safe-area-top-effective,0px),12px)] sm:px-8 md:max-w-none md:px-10 lg:px-14"
      data-one-feature-screen
    >
      <OnboardingNavigation
        plain
        currentStep={1}
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
        className="mx-auto w-full max-w-[700px] md:max-w-[1040px]"
      />
      <div
        className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
        data-one-feature-scroll
      >
        <header
          className="mx-auto mt-5 w-full max-w-[700px] shrink-0"
          data-one-feature-header
        >
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="ui-text-agent-title text-[#111823] outline-none dark:!text-[color:var(--app-label)]"
            data-one-feature-heading
          >
            Keep your people updated.
          </h1>
        </header>
        <div
          className="mx-auto mt-5 grid w-full max-w-[700px] shrink-0 gap-3"
          data-one-feature-grid
          data-one-story-container
        >
          <ShareLocationFeatureCard />
          <div
            className="grid grid-cols-2 items-start gap-3"
            data-one-feature-lower-grid
          >
            <CheckInFeatureCard />
            <SaveMySoulFeatureCard />
          </div>
        </div>
        <p
          className="shrink-0 pt-3 text-center text-[12px] font-semibold leading-4 text-[#6f7580] dark:text-[color:var(--app-secondary-label)]"
          aria-live="polite"
          role={
            locationPreparationRetry || locationBlocked ? "alert" : undefined
          }
        >
          {status}
        </p>
      </div>
      <div
        className="mx-auto w-full max-w-[430px] shrink-0 pt-5"
        data-one-feature-cta
      >
        <PrimaryButton
          onClick={onContinue}
          busy={permissionBusy}
          disabled={permissionBusy}
          className="h-[52px] min-h-[52px]"
        >
          {locationPreparationRetry
            ? "Try again"
            : locationBlocked
              ? "Open settings"
              : "Set up my location"}
        </PrimaryButton>
      </div>
      <style>{`
        @keyframes oneSmsRadar {
          0% { transform: scale(0.55); opacity: 0.65; }
          80% { opacity: 0; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-one-onboarding-motion] { animation: none !important; }
        }
        [data-one-feature-heading] {
          --type-agent-title-size: 31px;
          --type-agent-title-line: 1.08;
        }
        [data-one-feature-copy] {
          --one-feature-copy-gap: 10px;
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--one-feature-copy-gap);
        }
        @media (max-width: 430px) {
          [data-one-feature-screen] { padding-left: 16px; padding-right: 16px; }
          [data-one-feature-heading] { --type-agent-title-size: 31px; }
          [data-one-feature-card] { border-radius: 22px; }
        }
        @media (max-width: 380px) {
          [data-one-feature-screen] { padding-left: 14px; padding-right: 14px; }
          [data-one-feature-grid] { gap: 10px; }
          [data-one-feature-lower-grid] { gap: 10px; }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] {
            font-size: 17px;
          }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] {
            font-size: 12.5px;
            line-height: 1.34;
          }
        }
        @media (max-width: 340px) {
          [data-one-feature-screen] { padding-left: 12px; padding-right: 12px; }
          [data-one-feature-heading] { --type-agent-title-size: 29px; }
          [data-one-feature-grid] { gap: 8px; }
          [data-one-feature-lower-grid] { gap: 8px; }
          [data-one-feature-card] { border-radius: 20px; }
          [data-one-feature-card="share"] [data-one-feature-copy] {
            width: 60%;
            padding: 14px 14px 0;
          }
          [data-one-feature-card="share"] [data-one-feature-title] { font-size: 18px; }
          [data-one-feature-card="share"] [data-one-feature-body] { font-size: 12.5px; line-height: 1.34; }
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] { padding: 12px 12px 0; gap: 7px; }
          [data-one-feature-card="checkin"] [data-one-feature-title],
          [data-one-feature-card="sms"] [data-one-feature-title] { font-size: 15px; }
          [data-one-feature-card="checkin"] [data-one-feature-body],
          [data-one-feature-card="sms"] [data-one-feature-body] { font-size: 11.5px; line-height: 1.3; }
          [data-one-use-case-tag] { padding: 4px 9px; font-size: 10px; }
          [data-one-feature-cta] { padding-top: 14px; }
          [data-one-feature-cta] button { min-height: 50px; height: 50px; }
        }
        @media (max-height: 780px) {
          [data-one-feature-screen] {
            padding-top: max(var(--app-safe-area-top-effective, 0px), 8px);
            padding-bottom: max(env(safe-area-inset-bottom, 0px), 10px);
          }
          [data-one-onboarding-navigation] { height: 52px; }
          [data-one-feature-header] { margin-top: 8px; }
          [data-one-feature-grid] { margin-top: 14px; gap: 10px; }
          [data-one-feature-lower-grid] { gap: 10px; }
          [data-one-feature-cta] { padding-top: 14px; }
          [data-one-feature-cta] button { min-height: 50px; height: 50px; }
        }
        @media (min-width: 768px) {
          [data-one-feature-scroll] {
            align-items: center;
            flex: 0 0 auto;
          }
          [data-one-feature-header] {
            max-width: 1040px;
          }
          [data-one-feature-heading] {
            --type-agent-title-size: 34px;
          }
          [data-one-feature-grid] {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            grid-template-areas: "share checkin sms";
            align-items: stretch;
            max-width: 1040px;
            margin-top: 24px;
            gap: 18px;
          }
          [data-one-feature-lower-grid] {
            display: contents;
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
          [data-one-feature-card="share"] [data-one-feature-copy],
          [data-one-feature-card="checkin"] [data-one-feature-copy],
          [data-one-feature-card="sms"] [data-one-feature-copy] {
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
          [data-one-feature-card="checkin"] [data-one-use-case-art] {
            inset: auto 0 42px 0;
            width: 100%;
            height: 54%;
          }
          [data-one-feature-card="checkin"] [data-one-checkin-art] {
            width: 42%;
          }
          [data-one-feature-card="sms"] [data-one-feature-art-region] {
            align-items: center;
            justify-content: center;
          }
          [data-one-feature-cta] {
            max-width: 430px;
            padding-top: 22px;
            padding-bottom: 4px;
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
  source,
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
  embedded = false,
}: {
  state:
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "none"; partial: boolean }
    | { kind: "matched" }
    | { kind: "failed"; message: string; canOpenSettings: boolean };
  source: "device" | "google";
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
  embedded?: boolean;
}) {
  const MATCH_PAGE_SIZE = 100;
  const [visibleMatchCount, setVisibleMatchCount] = useState(MATCH_PAGE_SIZE);
  useEffect(() => setVisibleMatchCount(MATCH_PAGE_SIZE), [matches]);
  const visibleMatches = matches.slice(0, visibleMatchCount);
  const primed = state.kind === "idle" || state.kind === "busy";
  const contactOperationBusy = state.kind === "busy";
  const navigationDisabled = leaving || contactOperationBusy;

  return (
    <div
      className={cn(
        embedded
          ? "rounded-[18px] bg-[color:var(--app-card-surface-compact)] p-3.5"
          : "flex min-h-0 flex-1 flex-col bg-[color:var(--app-grouped-background)]",
      )}
      data-testid="one-location-onboarding-contacts-surface"
      aria-busy={contactOperationBusy}
    >
      {/* pt clears the status bar and notch. A bare pt-2 put Back and Skip
          under the clock and battery on every notched iPhone -- reachable
          only by guessing where they were. */}
      {!embedded ? (
        <header className="flex min-h-16 shrink-0 items-center justify-between px-5 pb-2 pt-[max(var(--app-safe-area-top-effective,0px),8px)]">
          <button
            type="button"
            onClick={onBack}
            disabled={navigationDisabled}
            className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] text-[#1f2b3d] disabled:opacity-50 dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
            aria-label="Go back"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <OnboardingSkipButton
            onClick={onSkip}
            disabled={navigationDisabled}
          />
        </header>
      ) : null}

      <div
        className={cn(!embedded && "min-h-0 flex-1 overflow-y-auto px-6 pb-4")}
      >
        <div className="mx-auto flex w-full max-w-[520px] flex-col">
          {!embedded ? (
            <>
              <span className="mt-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-[color:var(--app-accent-soft)] text-[color:var(--app-accent)]">
                <UserPlus className="h-7 w-7" strokeWidth={2} />
              </span>
              <h1 className="ui-text-agent-title mt-4 text-[#151b26] dark:!text-[color:var(--app-label)]">
                Find your people
              </h1>
            </>
          ) : null}
          <p className="mt-2 text-[15px] font-normal leading-[20px] text-[#73777f] dark:text-[color:var(--app-secondary-label)]">
            {primed
              ? "Find people from your contacts already on One. Nothing is added automatically."
              : state.kind === "matched"
                ? "Connected matches are ready. You can request the rest."
                : "You can always find people later from the People tab."}
          </p>

          {primed ? (
            <>
              <div
                className={cn(
                  "rounded-[20px] border border-[#e4e6e9] bg-white p-5 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]",
                  embedded ? "mt-4" : "mt-7",
                )}
              >
                {state.kind === "busy" ? (
                  <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-[#777d86] dark:text-[color:var(--app-secondary-label)]">
                    <Loader2 className="h-5 w-5 animate-spin" /> Checking your
                    contacts
                  </div>
                ) : (
                  <div className="flex min-h-28 flex-col items-center justify-center gap-4 text-center">
                    <p className="max-w-[320px] text-[15px] leading-5 text-[#5c626c] dark:text-[color:var(--app-secondary-label)]">
                      Connect contacts to see who is already here.
                    </p>
                    <PrimaryButton
                      className="mx-auto max-w-[360px]"
                      onClick={onSync}
                      disabled={leaving}
                    >
                      Check my contacts
                    </PrimaryButton>
                  </div>
                )}
              </div>
            </>
          ) : null}

          {state.kind === "matched" ? (
            <ul
              className="mt-6 space-y-2"
              data-testid="onboarding-contact-matches"
            >
              {visibleMatches.map((match) => {
                const added = addedUserIds.includes(match.userId);
                const adding = addingUserIds.includes(match.userId);
                const connected = match.connectionStatus === "connected";
                const requestRequired =
                  match.connectionStatus === "request_required";
                return (
                  <li
                    key={match.userId}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-[#e4e6e9] bg-white px-4 py-3 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-medium text-[#151b26] dark:text-[color:var(--app-label)]">
                      <span className="min-w-0 truncate">
                        {match.displayName}
                      </span>
                      {connected ? <ContactSourceBadge /> : null}
                    </span>
                    {requestRequired ? (
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
                        {added ? "Requested" : adding ? "Sending" : "Request"}
                      </button>
                    ) : (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-[#5c626c] dark:text-[#aeb8c7]">
                        {connected ? (
                          <Check className="h-4 w-4 text-emerald-600" />
                        ) : null}
                        {connected ? "Connected" : "Not connected"}
                      </span>
                    )}
                  </li>
                );
              })}
              {visibleMatches.length < matches.length ? (
                <li className="flex flex-col items-center gap-2 pt-2">
                  <span className="text-xs text-[#73777f]" aria-live="polite">
                    Showing {visibleMatches.length} of {matches.length}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleMatchCount((current) =>
                        Math.min(current + MATCH_PAGE_SIZE, matches.length),
                      )
                    }
                    className="press-scale min-h-11 rounded-full border border-[#e4e6e9] px-5 text-sm font-semibold dark:border-white/[0.08]"
                  >
                    Show more
                  </button>
                </li>
              ) : null}
            </ul>
          ) : null}

          {state.kind === "none" ? (
            <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 text-center dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]">
              <p className="text-[15px] leading-5 text-[#5c626c] dark:text-[color:var(--app-secondary-label)]">
                {state.partial
                  ? "None of the contacts you shared are on One yet."
                  : "None of your contacts are on One yet."}
              </p>
              <p className="mt-2 text-[13px] leading-5 text-[#96999e] dark:text-[color:var(--app-secondary-label)]">
                Use the circle code above to invite anyone you want here.
              </p>
            </div>
          ) : null}

          {state.kind === "failed" ? (
            <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 text-center dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]">
              <p className="text-[15px] leading-5 text-[#5c626c] dark:text-[color:var(--app-secondary-label)]">
                {state.message}
              </p>
              {state.canOpenSettings ? (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="press-scale mt-4 inline-flex min-h-11 items-center justify-center rounded-full border border-[#d5d9df] bg-white px-5 text-sm font-bold text-[#1f2b3d] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                >
                  Open Settings
                </button>
              ) : null}
              {source === "google" ? (
                <button
                  type="button"
                  onClick={onSync}
                  disabled={leaving}
                  className="press-scale mt-4 inline-flex min-h-11 items-center justify-center rounded-full border border-[#d5d9df] bg-white px-5 text-sm font-bold text-[#1f2b3d] disabled:opacity-50 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                >
                  Try again
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      {!embedded ? (
        <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-3">
          {/* Always present, whatever happened above. Declining contacts, finding
            nobody, or a plugin failure must never be a dead end. */}
          <div className="mx-auto w-full max-w-[520px]">
            <PrimaryButton
              className={primed && state.kind === "idle" ? "max-w-none" : ""}
              onClick={onContinue}
              disabled={navigationDisabled}
              inverse={primed && state.kind === "idle"}
            >
              {state.kind === "idle" ? "Not now" : "Continue"}
            </PrimaryButton>
          </div>
        </footer>
      ) : null}
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
 * It deliberately does not re-list Share / Check in / SOS. The features screen
 * already introduces those; saying them twice in a four-screen flow turns the
 * payoff into a summary slide. What is new here is the map, and the one thing
 * the map cannot show on its own -- that it is empty until someone joins.
 */
function ReadyScreen({
  currentUserName: _currentUserName,
  mapPoint,
  mapEmptyLabel,
  invite,
  loading,
  error,
  copied,
  onRetry,
  onCopy,
  onShare,
  onBack,
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
  activeDisclosure,
  onToggleDisclosure,
  contactsAvailable,
  contactState,
  contactsSource,
  contactMatches,
  addedContactIds,
  addingContactIds,
  onSyncContacts,
  onAddContact,
  onOpenContactSettings,
}: {
  currentUserName: string;
  mapPoint: { lat: number; lng: number } | null;
  /** What the map band says when there is no coordinate to draw. */
  mapEmptyLabel: string;
  invite: OnboardingCircleInvite | null;
  loading: boolean;
  error: string | null;
  copied: boolean;
  onRetry: () => void;
  onCopy: () => void;
  onShare: () => void;
  onBack: () => void;
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
  activeDisclosure: "join" | "contacts" | null;
  onToggleDisclosure: (disclosure: "join" | "contacts") => void;
  contactsAvailable: boolean;
  contactState:
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "none"; partial: boolean }
    | { kind: "matched" }
    | { kind: "failed"; message: string; canOpenSettings: boolean };
  contactsSource: "device" | "google";
  contactMatches: OnboardingContactMatch[];
  addedContactIds: string[];
  addingContactIds: string[];
  onSyncContacts: () => void;
  onAddContact: (userId: string) => void;
  onOpenContactSettings: () => void;
}) {
  const formattedCode = invite ? formatCircleCode(invite.code) : "";
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // A disclosure opens below the fold on a phone. Move only the panel's own
  // scroller far enough to reveal it, otherwise the tap appears to do nothing
  // except rotate a chevron while the new controls remain behind the pinned
  // Finish footer.
  useEffect(() => {
    if (!activeDisclosure) return;
    const frame = window.requestAnimationFrame(() => {
      const panel = document.getElementById(
        activeDisclosure === "join"
          ? "onboarding-join-circle-panel"
          : "onboarding-contacts-panel",
      );
      panel?.scrollIntoView?.({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "nearest",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeDisclosure]);

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
        emptyLabel={mapEmptyLabel}
        className={READY_MAP_CLASSNAME}
      />

      {/* Floats over the map: the controls stay reachable without stealing a
          band of the map, and both sit on their own translucent chips. */}
      {/* Same clearance, and it matters more here: the header floats over
          the map, so without it the controls sit directly under the status
          bar with map tiles behind both. */}
      <header className="absolute inset-x-0 top-0 z-20 grid min-h-16 shrink-0 grid-cols-[minmax(64px,1fr)_minmax(120px,220px)_minmax(64px,1fr)] items-center gap-2 px-5 pb-2 pt-[max(var(--app-safe-area-top-effective,0px),8px)]">
        <button
          type="button"
          onClick={onBack}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-white/85 text-[#1f2b3d] shadow-[0_2px_10px_rgba(24,57,91,0.14)] backdrop-blur-sm dark:bg-[color:var(--app-glass-surface)] dark:text-[color:var(--app-label)] dark:shadow-[var(--app-glass-shadow)]"
          aria-label="Go back"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <span className="rounded-[14px] bg-white/90 px-3 py-2 shadow-[0_2px_10px_rgba(24,57,91,0.14)] backdrop-blur-sm dark:bg-[color:var(--app-glass-surface)] dark:shadow-[var(--app-glass-shadow)]">
          <OnboardingStepper
            steps={ONE_LOCATION_ONBOARDING_STEPS}
            currentIndex={3}
            compact
            ariaLabel="One Location setup progress"
          />
        </span>
        <span className="h-11 w-11 justify-self-end" aria-hidden />
      </header>

      <div
        className={READY_PANEL_CLASSNAME}
        data-testid="one-location-onboarding-ready-panel"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4 pt-6 md:px-7 md:pb-5 md:pt-7">
          {/* The headline is the map's, so it only gets to make the claim when
              there is a map. Reaching this screen after deliberately skipping
              Location setup is an ordinary outcome, and
              telling that person they are on a map, over a panel that says the
              map is unavailable, is the one thing this screen must not do. */}
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="ui-text-agent-title pb-1 leading-[1.15] text-[#151b26] outline-none dark:!text-[color:var(--app-label)]"
            data-one-ready-title
          >
            {mapPoint ? "You're on the map." : "You're all set."}
          </h1>
          <p className="mt-2 text-[15px] font-normal leading-[20px] text-[#73777f] dark:text-[color:var(--app-secondary-label)]">
            Private until you share.
          </p>

          {/* "Your people show up here once they join." used to sit here, with a
            dashed empty-seat avatar beside it. The map above and the invite
            card below already say it between them, and a screen a person reads
            in three seconds cannot afford a sentence that only restates its own
            layout. */}
          <div
            className="mt-6 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-5 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]"
            data-testid="one-location-onboarding-invite-card"
            data-one-ready-code
          >
            {loading ? (
              <div className="flex min-h-24 items-center justify-center gap-2 text-sm text-[#777d86] dark:text-[color:var(--app-secondary-label)]">
                <Loader2 className="h-5 w-5 animate-spin" /> Getting your code
              </div>
            ) : error ? (
              <div className="flex min-h-24 flex-col items-center justify-center gap-3 text-center">
                <p className="max-w-[260px] text-sm leading-5 text-[#6f7580] dark:text-[color:var(--app-secondary-label)]">
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
                {/* The circle's name, not a sentence wrapped around it. "Bring
                  your people to Ankit's Circle" spent five words introducing
                  the two things directly under it -- a code and a Share
                  button -- which the card's own shape already introduces. */}
                <p className="text-[13px] font-medium leading-[18px] text-[#6E6E73] dark:text-[color:var(--app-secondary-label)]">
                  {invite.circleName}
                </p>
                <p
                  className={READY_CODE_CLASSNAME}
                  data-testid="one-location-onboarding-invite-code"
                  data-ui-contract="required-copy"
                  data-ui-id="onboarding-invite-code"
                  data-ui-truncation="forbid"
                >
                  {formattedCode}
                </p>
                {/* Kept, shortened. The expiry changes what the person does with
                  the code, so it stays; "You can get a fresh one any time" is a
                  reassurance about a screen they have not reached yet. */}
                <p className="mt-2 text-[12px] leading-[18px] text-[#96999e] dark:text-[color:var(--app-secondary-label)]">
                  Expires in 72 hours
                </p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={onCopy}
                    className="press-scale inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[#d5d9df] bg-white text-[15px] font-bold text-[#1f2b3d] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
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
              <p className="flex min-h-24 items-center justify-center px-2 text-center text-sm leading-5 text-[#6f7580] dark:text-[color:var(--app-secondary-label)]">
                {/* Where to get it is the button at the bottom of this screen,
                  which already says "Open One Location". Saying it again here
                  is the paragraph this card used to be. */}
                Your code isn&apos;t ready yet.
              </p>
            )}
          </div>

          {joinEnabled ? (
            <div className="mt-4" data-testid="onboarding-join-circle">
              <button
                type="button"
                onClick={() => onToggleDisclosure("join")}
                aria-expanded={activeDisclosure === "join"}
                aria-controls="onboarding-join-circle-panel"
                className="press-scale flex min-h-12 w-full items-center gap-3 rounded-[18px] border border-[#e4e6e9] bg-white px-4 text-left text-[15px] font-bold text-[#1f2b3d] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                data-testid="onboarding-join-circle-toggle"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]">
                  <UserPlus className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">Join with a code</span>
                <ChevronDown
                  className={cn(
                    "h-5 w-5 shrink-0 text-muted-foreground transition-transform",
                    activeDisclosure === "join" && "rotate-180",
                  )}
                  aria-hidden
                />
              </button>
              {activeDisclosure === "join" ? (
                <div
                  id="onboarding-join-circle-panel"
                  className="mt-3"
                  data-testid="onboarding-join-circle-panel"
                >
                  {joinAccepted ? (
                    <p
                      className="flex items-center gap-2 rounded-[18px] border border-[color:var(--app-accent)]/25 bg-[color:var(--app-accent-soft)] px-4 py-3 text-[14px] font-medium leading-5 text-[#1f2b3d] dark:bg-[color:var(--app-accent-tint)] dark:text-[color:var(--app-label)]"
                      role="status"
                    >
                      <Check
                        className="h-4 w-4 shrink-0 text-[color:var(--app-accent)]"
                        strokeWidth={2.5}
                        aria-hidden
                      />
                      You&apos;ll join {joinPreview?.name ?? "their circle"}{" "}
                      after setup.
                    </p>
                  ) : joinPreview ? (
                    <div
                      className="rounded-[18px] border border-[#e4e6e9] bg-[#f8f9fb] p-4 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]"
                      data-testid="onboarding-join-circle-preview"
                    >
                      <p className="text-[15px] font-bold leading-5 text-[#151b26] dark:text-[color:var(--app-label)]">
                        {joinPreview.name}
                      </p>
                      <p className="mt-1 text-[13px] leading-[18px] text-[#73777f] dark:text-[color:var(--app-secondary-label)]">
                        {joinPreview.ownerDisplayName} &middot;{" "}
                        {joinPreview.memberCount}{" "}
                        {joinPreview.memberCount === 1 ? "person" : "people"}
                      </p>
                      {!joinPreview.alreadyMember ? (
                        <button
                          type="button"
                          onClick={onAcceptJoinCode}
                          disabled={joinBusy || leaving}
                          className="press-scale mt-3 inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-[color:var(--app-accent)] text-[15px] font-bold text-[color:var(--app-accent-fg)] disabled:opacity-60"
                        >
                          {joinBusy ? (
                            <Loader2
                              className="h-4 w-4 animate-spin"
                              aria-hidden
                            />
                          ) : null}
                          Join {joinPreview.name}
                        </button>
                      ) : (
                        <p className="mt-3 text-[13px] text-muted-foreground">
                          Already in this circle.
                        </p>
                      )}
                      <button
                        type="button"
                        onClick={onClearJoinPreview}
                        disabled={joinBusy || leaving}
                        className="press-scale mt-2 min-h-11 w-full text-[14px] font-bold text-[color:var(--app-accent-deep)] disabled:opacity-50"
                        data-testid="onboarding-join-circle-reset"
                      >
                        Use a different code
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        value={joinCode}
                        onChange={(event) =>
                          onJoinCodeChange(event.target.value)
                        }
                        placeholder="Enter their code"
                        aria-label="Circle code"
                        autoCapitalize="characters"
                        autoCorrect="off"
                        spellCheck={false}
                        aria-describedby={
                          joinError ? "onboarding-join-code-error" : undefined
                        }
                        className="h-11 min-w-0 flex-1 rounded-full border border-[#d5d9df] bg-white px-4 font-mono text-[15px] uppercase tracking-[0.08em] text-[#151b26] outline-none focus:border-[color:var(--app-accent)] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                      />
                      <button
                        type="button"
                        onClick={onPreviewJoinCode}
                        disabled={joinBusy || !joinCode.trim() || leaving}
                        className="press-scale inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-full border border-[#d5d9df] bg-white px-4 text-[15px] font-bold text-[#1f2b3d] disabled:opacity-50 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                      >
                        {joinBusy ? (
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            aria-hidden
                          />
                        ) : null}
                        Look up
                      </button>
                    </div>
                  )}
                  {joinError ? (
                    <p
                      id="onboarding-join-code-error"
                      className="mt-2 text-center text-[13px] leading-[18px] text-[color:var(--app-destructive)]"
                      role="alert"
                    >
                      {joinError}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {contactsAvailable ? (
            <div className="mt-3" data-testid="onboarding-contacts-disclosure">
              <button
                type="button"
                onClick={() => onToggleDisclosure("contacts")}
                aria-expanded={activeDisclosure === "contacts"}
                aria-controls="onboarding-contacts-panel"
                className="press-scale flex min-h-12 w-full items-center gap-3 rounded-[18px] border border-[#e4e6e9] bg-white px-4 text-left text-[15px] font-bold text-[#1f2b3d] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-[color:var(--app-accent)]/10 text-[color:var(--app-accent)]">
                  <UserPlus className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">Find contacts</span>
                <ChevronDown
                  className={cn(
                    "h-5 w-5 shrink-0 text-muted-foreground transition-transform",
                    activeDisclosure === "contacts" && "rotate-180",
                  )}
                  aria-hidden
                />
              </button>
              {activeDisclosure === "contacts" ? (
                <div id="onboarding-contacts-panel" className="mt-3">
                  <ContactsScreen
                    embedded
                    state={contactState}
                    source={contactsSource}
                    matches={contactMatches}
                    addedUserIds={addedContactIds}
                    addingUserIds={addingContactIds}
                    onSync={onSyncContacts}
                    onAdd={onAddContact}
                    onOpenSettings={onOpenContactSettings}
                    onBack={() => undefined}
                    onSkip={() => undefined}
                    onContinue={() => undefined}
                    leaving={leaving}
                  />
                </div>
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
              className="mb-3 text-center text-[13px] leading-5 text-[#96999e] dark:text-[color:var(--app-secondary-label)]"
              role="status"
            >
              That didn&apos;t save. Tap again.
            </p>
          ) : null}
          {/* Always the completion CTA. A code that failed to load is not a
              reason to record the whole capability as skipped -- the person
              granted permission and saved a place, so finishing is the honest
              outcome. Retrying the code lives inside the card above. */}
          <PrimaryButton
            onClick={onContinue}
            busy={completing}
            disabled={leaving}
          >
            {completeLabel}
          </PrimaryButton>
        </footer>
      </div>

      <style>{`
        [data-one-ready-title] { animation: oneReadyRise 520ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        [data-one-ready-code] { animation: oneReadyRise 560ms cubic-bezier(0.22, 1, 0.36, 1) both; animation-delay: 140ms; }
        ${READY_MAP_SHORT_WINDOW_CSS}
        @keyframes oneReadyRise {
          from { opacity: 0; transform: translateY(14px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [data-one-ready-title],
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
  activeScreen,
  onScreenChange,
  currentUserName,
  locationPermission,
  locationBusy,
  nativeTest,
  onRequestLocation,
  onLocationReady,
  onBack,
  onComplete,
  onSkip = onComplete,
  completeLabel = "Open One Location",
  mapPoint = null,
  contactsStepAvailable = true,
  contactsSource = "device",
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

  /**
   * The account's position, from the one place the whole app already keeps it.
   *
   * `auto` resolves a fix on mount ONLY when the OS has already granted
   * permission; it never triggers a first prompt, which matters more here than
   * anywhere -- iOS grants exactly one Core Location alert per install, and
   * this flow's entire second screen exists to spend it deliberately.
   *
   * Subscribed here rather than in the Location page because the bus updates
   * as the device reports, and the page is a very large tree that has no reason
   * to re-render for a coordinate only the finale reads. The onboarding overlay
   * is mounted for a minute at most.
   */
  const { snapshot: deviceSnapshot } = useCurrentLocation({ auto: true });

  /**
   * Where the finale's camera actually goes.
   *
   * `mapPoint` is the page's answer from the three sources it owns. All three
   * are empty on ordinary runs -- someone who skipped the save-place step, or
   * granted Location and walked straight through -- and the screen then drew a
   * picture of a map the person was not on. The bus is the last resort.
   */
  const finaleMapPoint = useMemo(
    () =>
      resolveOnboardingFinaleMapPoint({
        onboarding: mapPoint,
        device: deviceSnapshot,
      }),
    [deviceSnapshot, mapPoint],
  );

  const [internalScreen, setInternalScreen] = useState<OnboardingScreen>(() =>
    initialScreen(startAt),
  );
  const screen = activeScreen ?? internalScreen;
  const setScreen = useCallback(
    (next: OnboardingScreen) => {
      setInternalScreen(next);
      onScreenChange?.(next);
    },
    [onScreenChange],
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
  const [contactMatches, setContactMatches] = useState<
    OnboardingContactMatch[]
  >([]);
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
  const [activeReadyDisclosure, setActiveReadyDisclosure] = useState<
    "join" | "contacts" | null
  >(null);
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
  /**
   * The states where asking again cannot help: refused, held by device policy,
   * or the phone's Location Services switch is off. `prompt` and a null (not
   * yet read) permission are deliberately NOT blocked -- those are the states
   * where the answer is still coming.
   *
   * Read on the finale only, to name the right reason for an empty map band.
   */
  const locationBlocked =
    locationPermission?.state === "denied" ||
    locationPermission?.state === "restricted" ||
    locationPermission?.locationServicesEnabled === false;
  const prepareSavedLocation = useCallback(
    (permissionReady = locationGranted): Promise<boolean> => {
      if (!permissionReady) return Promise.resolve(false);
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
    },
    [locationGranted, onLocationReady],
  );

  useEffect(() => {
    if (activeScreen) return;
    setInternalScreen(initialScreen(startAt));
  }, [activeScreen, startAt]);

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
          : // The state, not the apology. "Try again" is the button directly
            // under this line, so the sentence does not have to say it too.
            "Couldn't get your code.",
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
    if (screen !== "ready") return;
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
    void Promise.resolve(onCopyOnboardingCircleCode?.(circleInvite.code)).catch(
      () => {
        /* parent surfaces its own failure toast */
      },
    );
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
    void Promise.resolve(onShareOnboardingCircleCode?.(circleInvite)).catch(
      () => {
        /* parent surfaces its own failure toast */
      },
    );
  }, [circleInvite, onShareOnboardingCircleCode]);

  const handleSyncContacts = useCallback(async () => {
    if (!onSyncOnboardingContacts) return;
    setContactState({ kind: "busy" });
    try {
      const result = await onSyncOnboardingContacts();
      if (result.status === "cancelled") {
        setContactState({ kind: "idle" });
        return;
      }
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

  const openFeatures = () => {
    setScreen("features");
  };

  const backFromFeatures = () => {
    if (startAt === "permissions") {
      void runBack();
      return;
    }
    setScreen("welcome");
  };

  const continueFromFeatures = () => {
    if (locationBusy || locationPreparationBusy) return;
    setLocationPreparationRetry(false);
    void (async () => {
      let permissionReady = locationGranted;
      if (!permissionReady) {
        try {
          permissionReady = (await onRequestLocation()) === true;
        } catch {
          permissionReady = false;
        }
      }
      if (!permissionReady) return;
      const prepared = await prepareSavedLocation(true);
      if (prepared) setScreen("place");
    })();
  };

  return (
    <main
      // Onboarding is modal; nothing from the app shell belongs over it. Keep
      // it above elevated Talk to One / bottom-nav states without touching those
      // global controls.
      className="fixed inset-0 z-[9000] flex h-dvh min-h-[100svh] w-full items-stretch justify-center overflow-hidden bg-[color:var(--app-grouped-background)] text-[#171d28] [--type-agent-title-size:34px] dark:text-[color:var(--app-label)] sm:[--type-agent-title-size:44px]"
      data-one-onboarding-design="location-agent-v2"
      data-no-route-swipe
      data-testid="one-location-onboarding"
      data-location-onboarding-screen={screen}
    >
      <NativeTestBeacon {...nativeTest} />
      <section
        className={cn(
          "flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[color:var(--app-grouped-background)]",
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
          "max-w-none",
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
            locationBusy={locationBusy}
            locationPreparationBusy={locationPreparationBusy}
            locationPreparationRetry={locationPreparationRetry}
            onBack={backFromFeatures}
            onSkip={() => void runSkip()}
            leaving={leaving}
            onContinue={continueFromFeatures}
          />
        ) : null}
        {/* Tile prewarm. The script being ready is only half of it -- the map
            still has to fetch imagery for this exact point, and doing that on
            arrival is what makes the finale look like it is thinking. A
            full-size instance renders here, invisibly, so the tiles are in the
            browser cache before the screen that shows them exists. It unmounts
            as the finale mounts, so there is never a second live map. */}
        {screen === "place" && finaleMapPoint ? (
          <OnboardingLiveMap
            point={finaleMapPoint}
            className="pointer-events-none absolute inset-0 -z-10 opacity-0"
          />
        ) : null}
        {screen === "ready" ? (
          <ReadyScreen
            currentUserName={currentUserName}
            mapPoint={finaleMapPoint}
            // Two different reasons produce an empty map band, and only the
            // caller can tell them apart. "Map unavailable" in front of someone
            // who refused Location blames the wrong thing and hides the one
            // thing they could change.
            mapEmptyLabel={
              locationBlocked ? "Location is off" : "Map unavailable"
            }
            invite={circleInvite}
            loading={circleInviteLoading}
            error={circleInviteError}
            copied={circleInviteCopied}
            onRetry={() => void prepareCircleInvite()}
            onCopy={handleCopyCircleInvite}
            onShare={handleShareCircleInvite}
            onBack={() => setScreen("place")}
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
            activeDisclosure={activeReadyDisclosure}
            onToggleDisclosure={(disclosure) =>
              setActiveReadyDisclosure((current) =>
                current === disclosure ? null : disclosure,
              )
            }
            contactsAvailable={
              contactsStepAvailable && Boolean(onSyncOnboardingContacts)
            }
            contactState={contactState}
            contactsSource={contactsSource}
            contactMatches={contactMatches}
            addedContactIds={addedContactIds}
            addingContactIds={addingContactIds}
            onSyncContacts={() => void handleSyncContacts()}
            onAddContact={handleAddContact}
            onOpenContactSettings={() => onOpenContactSettings?.()}
          />
        ) : null}
      </section>
    </main>
  );
}
