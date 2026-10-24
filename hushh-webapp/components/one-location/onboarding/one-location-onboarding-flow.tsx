"use client";

import { useSessionChromeSuppression } from "@/lib/auth/use-session-chrome-suppression";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Share2,
  UserPlus,
} from "@/components/icons";
import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import { OnboardingStepper } from "@/components/app-ui/onboarding-stepper";
import { Button } from "@/components/ui/button";
import { Button as MorphyButton } from "@/lib/morphy-ux/button";
import {
  LOCATION_CONNECT_ACTION_PILL_CLASSNAME,
  LOCATION_CONNECT_ACTION_TARGET_CLASSNAME,
} from "@/components/one-location/redesign/location-action-styles";
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
import locationOnboardingContract from "@/lib/onboarding/one-location-onboarding.contract.json";
import { trackEvent } from "@/lib/observability/client";
import { trackLocationFunnelStepCompleted } from "@/lib/observability/growth";
import { resolveRouteId } from "@/lib/observability/route-map";
import { cn } from "@/lib/utils";
import { useBackLayer } from "@/lib/navigation/back-layers";

type OnboardingScreen = OneLocationOnboardingScreen;

const LOCATION_SCREEN_TEST_IDS = Object.fromEntries(
  locationOnboardingContract.screens.map(({ key, testId }) => [key, testId]),
) as Record<OnboardingScreen, string>;

// Legacy entry names restart at Features without requesting device access.
export type OneLocationOnboardingStart = "features" | "welcome" | "permissions";

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
  connectionStatus:
    "auto_connected" | "already_connected" | "request_required" | "suppressed";
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
  | {
      status: "matched";
      matches: OnboardingContactMatch[];
      partial?: boolean;
      summary?: string;
    }
  | { status: "none"; partial: boolean; summary?: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string; canOpenSettings: boolean };

type OnboardingContactState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "none"; partial: boolean; summary?: string }
  | { kind: "matched"; partial: boolean; summary?: string }
  | { kind: "failed"; message: string; canOpenSettings: boolean };

type OneLocationOnboardingFlowProps = {
  startAt: OneLocationOnboardingStart;
  /** Account-scoped checkpoint for the introduction. */
  activeScreen?: OnboardingScreen;
  onScreenChange?: (screen: OnboardingScreen) => void;
  currentUserName: string;
  nativeTest: React.ComponentProps<typeof NativeTestBeacon>;
  onBack: () => void | Promise<void>;
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  /**
   * Label for the final CTA. Setup ends back in the wizard, the workspace ends
   * on the Location hub, and saying so beats a generic "Done" that leaves the
   * person guessing where the button goes.
   */
  completeLabel?: string;
  completeControlId?: string;
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
  /**
   * Ask for device location and open the save-a-place surface, which the
   * parent hosts over this flow. Resolves true once that surface is open, and
   * false when it could not open (permission refused, no position, a place
   * already saved this journey). False moves on to Ready: refusing location
   * must never trap anyone on Features, and the Now tab keeps offering it.
   * Omitted, the flow goes straight from Features to Ready.
   */
  onPreparePlace?: () => Promise<boolean>;
  contactsStepAvailable?: boolean;
  /** Account-backed web fallback versus the device address book. */
  contactsSource?: "device" | "google";
  /**
   * Read the address book and return whichever contacts already have One.
   * Called only after the person taps on the contacts screen, never on mount.
   */
  onSyncOnboardingContacts?: (options?: {
    chooseGoogleAccount?: boolean;
  }) => Promise<OnboardingContactSyncResult>;
  /** Latest settled result, including retries started from the named sheet. */
  contactSyncResult?: OnboardingContactSyncResult | null;
  /** Offer the Google account chooser after an empty Google read. */
  showGoogleAccountSwitcher?: boolean;
  /** Send a connection request to one matched contact. */
  onAddOnboardingContact?: (userId: string) => Promise<void>;
  /** Open the OS settings page so a declined permission can be changed. */
  onOpenContactSettings?: (resume: () => void) => void;
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

function PrimaryButton({
  children,
  onClick,
  disabled = false,
  busy = false,
  inverse = false,
  className,
  voiceControlId,
}: {
  children: ReactNode;
  voiceControlId?: string;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  inverse?: boolean;
  className?: string;
}) {
  return (
    <Button data-location-type-role="primary-action"
      type="button"
      size="prominent"
      onClick={onClick}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      data-voice-control-id={voiceControlId}
      className={cn(
        "mx-auto flex w-full max-w-[244px] disabled:cursor-not-allowed disabled:opacity-50",
        inverse
          ? "bg-white text-[color:var(--app-accent-deep)] hover:bg-white/90 hover:text-[color:var(--app-accent-deep)] dark:bg-white dark:hover:bg-white/90 dark:text-[#07111f] dark:hover:text-[#07111f]"
          : "bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)] hover:bg-[color:var(--app-accent-hover)]",
        className,
      )}
    >
      {busy ? (
        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </Button>
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
    <button data-location-type-role="utility-action"
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "ui-text-button-label min-h-11 justify-self-end rounded-full disabled:opacity-50",
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

/** Minimal, stylised street-map backdrop used behind the share / check-in art. */
function MapBackdrop({ tone }: { tone: "share" | "checkin" | "sms" }) {
  const park = tone === "sms" ? "#f4dedd" : "#dcecd8";
  return (
    <svg
      viewBox="0 0 200 168"
      preserveAspectRatio="xMidYMid slice"
      className="absolute inset-0 h-full w-full"
      aria-hidden="true"
      data-one-feature-map={tone}
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

function FeatureTitle({
  lines,
  className,
}: {
  lines: readonly string[];
  className?: string;
}) {
  return (
    <div
      role="heading"
      aria-level={2}
      aria-label={lines.join(" ")}
      className={cn(
        "ui-text-headline text-[#111823] dark:text-[color:var(--app-label)]",
        className,
      )}
      data-one-feature-title
      data-location-type-role="section-heading"
    >
      {lines.map((line) => (
        <span
          key={line}
          aria-hidden="true"
          className="block"
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
      <span className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[color:var(--app-primary-surface)]/95 from-[25%] via-[color:var(--app-primary-surface)]/80 via-[51%] to-transparent" />
      <div className="relative z-20 w-[56%] px-5 pt-5 md:bg-[color:var(--app-primary-surface)]" data-one-feature-copy>
        <span data-location-type-role="row-description"
          className="inline-flex rounded-full bg-[color:var(--app-accent-tint)] px-3 py-1 ui-text-eyebrow text-[color:var(--app-accent-deep)] dark:bg-[color:var(--app-accent-surface)] dark:text-[color:var(--app-accent-bright)]"
          data-one-use-case-tag
        >
          Share location
        </span>
        <FeatureTitle
          lines={["Can’t explain", "where you are?"]}
        />
        <p data-location-type-role="row-description"
          className="ui-text-page-subtitle text-[#747b86] dark:text-[color:var(--app-secondary-label)]"
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
      className="relative flex aspect-[0.62/1] w-full flex-col overflow-hidden rounded-[26px] bg-[color:var(--app-primary-surface)] [container-type:inline-size]"
      data-testid="location-use-case-checkin"
      data-one-use-case-card
      data-one-feature-card="checkin"
    >
      <div
        className="relative z-20 bg-[color:var(--app-primary-surface)]/90 px-4 pb-2 pt-4"
        data-one-feature-copy
      >
        <span data-location-type-role="row-description"
          className="inline-flex rounded-full bg-[#dff4e7] px-3 py-1 ui-text-eyebrow text-[#27884f] dark:bg-[color:var(--app-success-surface)] dark:text-[color:var(--app-success-bright)]"
          data-one-use-case-tag
        >
          Check in
        </span>
        <FeatureTitle
          lines={["At the venue, but", "can't find each other?"]}
        />
        <p data-location-type-role="row-description"
          className="ui-text-page-subtitle text-[#747b86] dark:text-[color:var(--app-secondary-label)]"
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
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-[62%] bg-gradient-to-b from-[color:var(--app-primary-surface)]/80 to-transparent"
        aria-hidden="true"
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[46%]"
        data-one-use-case-art
        aria-hidden="true"
      >
        <span
          className="absolute bottom-[18%] left-1/2 flex h-[64px] w-[64px] -translate-x-1/2 items-center justify-center rounded-full bg-white/90 shadow-[0_8px_22px_rgba(24,57,91,0.16)] ring-1 ring-white/80 dark:bg-[color:var(--app-secondary-surface)] dark:shadow-none dark:ring-[color:var(--app-separator)]"
          data-one-checkin-destination
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- Local Maps-style artwork must render in Capacitor static export. */}
          <img
            src="/one-location/onboarding/check-in-location-pin.svg"
            alt=""
            className="h-10 w-10"
            data-one-checkin-pin
          />
        </span>
      </div>
    </article>
  );
}

function SaveMySoulFeatureCard() {
  return (
    <article
      className="relative flex w-full flex-col overflow-hidden rounded-[26px] bg-[color:var(--app-primary-surface)] [container-type:inline-size]"
      data-testid="location-use-case-sos"
      data-one-use-case-card
      data-one-feature-card="sms"
    >
      <MapBackdrop tone="sms" />
      <div className="relative z-20 bg-[color:var(--app-primary-surface)]/90 px-4 pb-2 pt-4" data-one-feature-copy>
        <span data-location-type-role="row-description"
          className="inline-flex rounded-full bg-[#ffe0df] px-3 py-1 ui-text-eyebrow text-[#d44442] dark:bg-[color:var(--app-destructive-surface)] dark:text-[color:var(--app-destructive-bright)]"
          data-one-use-case-tag
        >
          SMS · Save My Soul
        </span>
        <FeatureTitle
          lines={["Need help but", "can’t talk?"]}
        />
        <p data-location-type-role="row-description"
          className="ui-text-page-subtitle text-[#747b86] dark:text-[color:var(--app-secondary-label)]"
          data-one-feature-body
        >
          Alert your contacts with your live location.
        </p>
      </div>
      <div
        className="relative z-10 flex min-h-[116px] flex-1 items-center justify-center"
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
              className="absolute inset-0 rounded-full"
            />
            <span
              data-one-onboarding-motion
              data-one-sms-radar-ring
              className="absolute inset-0 rounded-full"
            />
            <span
              data-one-sms-core
              className="relative z-10 flex h-14 w-14 items-center justify-center rounded-full bg-[#ff3b30] text-[15px] font-bold text-white shadow-[0_12px_22px_rgba(255,59,48,0.28)] dark:shadow-none"
            >
              <span data-location-type-role="row-description" className="relative z-10" data-one-sms-label>
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
  onBack,
  onSkip,
  leaving,
  continueBusy = false,
  onContinue,
}: {
  onBack: () => void;
  onSkip: () => void;
  leaving: boolean;
  continueBusy?: boolean;
  onContinue: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div
      className="relative z-50 pointer-events-auto mx-auto flex h-full min-h-0 w-full max-w-[430px] max-[431px]:max-w-none flex-1 flex-col overflow-hidden bg-[color:var(--app-grouped-background)] px-5 pb-[max(env(safe-area-inset-bottom,0px),18px)] pt-[max(var(--app-safe-area-top-effective,0px),12px)] sm:px-8 md:max-w-none md:px-10 lg:px-14"
      data-one-feature-screen
    >
      <OnboardingNavigation
        plain
        currentStep={0}
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
          <h1 data-location-type-role="flow-title"
            ref={headingRef}
            tabIndex={-1}
            className="ui-text-page-title text-[#111823] outline-none dark:!text-[color:var(--app-label)]"
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
            className="grid grid-cols-1 items-stretch gap-3"
            data-one-feature-lower-grid
          >
            <CheckInFeatureCard />
            <SaveMySoulFeatureCard />
          </div>
        </div>
      </div>
      <div
        className="mx-auto w-full max-w-[244px] shrink-0 pt-5"
        data-one-feature-cta
      >
        <PrimaryButton
          onClick={onContinue}
          disabled={leaving}
          busy={continueBusy}
        >
          Continue
        </PrimaryButton>
      </div>
      <style>{`
        @keyframes oneSmsRadar {
          0% { transform: scale(0.72); opacity: 0.7; }
          100% { transform: scale(1.35); opacity: 0; }
        }
        [data-one-sms-radar-ring] {
          border: 2px solid #ff3b30;
          animation: oneSmsRadar 2.4s ease-out infinite;
        }
        [data-one-sms-radar-ring]:nth-child(2) {
          animation-delay: -1.2s;
        }
        @media (prefers-reduced-motion: reduce) {
          [data-one-onboarding-motion] { animation: none !important; }
          [data-one-sms-radar-ring] { opacity: 0; }
        }
        [data-one-feature-copy] {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 8px;
        }
        [data-one-feature-card] {
          aspect-ratio: auto;
          min-height: 190px;
        }
        [data-one-feature-copy] {
          width: 62%;
          padding: 18px 16px;
        }
        [data-one-feature-card="share"] [data-one-use-case-art] {
          width: 40%;
        }
        [data-one-feature-card="checkin"] [data-one-use-case-art] {
          inset: 0 0 0 auto;
          width: 38%;
          height: 100%;
        }
        [data-one-sms-radar-clearance] { width: 86px; height: 86px; }
        [data-one-sms-radar] { width: 64px; height: 64px; }
        [data-one-feature-card="sms"] [data-one-feature-art-region] {
          position: absolute;
          inset: 0 0 0 auto;
          width: 38%;
          height: 100%;
          align-items: center;
          justify-content: center;
        }
        @media (max-width: 380px) {
          [data-one-feature-screen] { padding-left: 16px; padding-right: 16px; }
          [data-one-feature-copy] { width: 68%; padding: 16px 14px; }
        }
        @media (max-height: 780px) {
          [data-one-feature-screen] {
            padding-top: max(var(--app-safe-area-top-effective, 0px), 8px);
            padding-bottom: max(env(safe-area-inset-bottom, 0px), 10px);
          }
          [data-one-onboarding-navigation] { height: 52px; }
          [data-one-feature-header] { margin-top: 8px; }
          [data-one-feature-grid] { margin-top: 16px; }
          [data-one-feature-cta] { padding-top: 16px; }
        }
        @media (min-width: 768px) {
          [data-one-feature-scroll] { flex: 0 1 auto; }
          [data-one-feature-header], [data-one-feature-grid] { max-width: 1040px; }
          [data-one-feature-grid] {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            align-items: stretch;
            gap: 18px;
          }
          [data-one-feature-lower-grid] { display: contents; }
          [data-one-feature-card] { min-height: 350px; }
          [data-one-feature-copy] { width: 100%; padding: 20px; }
          [data-one-feature-card="share"] [data-one-use-case-art],
          [data-one-feature-card="checkin"] [data-one-use-case-art],
          [data-one-feature-card="sms"] [data-one-feature-art-region] {
            inset: auto 0 16px 0;
            width: 100%;
            height: 46%;
          }
          [data-one-feature-card="checkin"] [data-one-checkin-art] { width: 34%; }
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
  showGoogleAccountSwitcher = false,
  onSyncDifferentGoogleAccount,
}: {
  state: OnboardingContactState;
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
  /**
   * Offer the Google account chooser after an empty Google read. Silent
   * retries re-read the same (possibly empty) account, so without this the
   * person loops on "No eligible contacts matched" with no way out.
   */
  showGoogleAccountSwitcher?: boolean;
  onSyncDifferentGoogleAccount?: () => void;
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
              <h1 data-location-type-role="flow-title" className="ui-text-agent-title mt-4 text-[#151b26] dark:!text-[color:var(--app-label)]">
                Find your people
              </h1>
            </>
          ) : null}
          <p data-location-type-role="row-description" className="ui-text-page-subtitle mt-2 text-[#73777f] dark:text-[color:var(--app-secondary-label)]">
            {primed
              ? "Find people from your contacts already on One. Exact matches connect automatically."
              : state.kind === "matched"
                ? "Your matched ONE contacts and connection results are ready."
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
                  <div data-location-type-role="row-description" className="flex min-h-32 items-center justify-center gap-2 text-sm text-[#777d86] dark:text-[color:var(--app-secondary-label)]">
                    <Loader2 className="h-5 w-5 animate-spin" /> Checking your
                    contacts
                  </div>
                ) : (
                  <div className="flex min-h-28 flex-col items-center justify-center gap-4 text-center">
                    <p data-location-type-role="row-description" className="max-w-[320px] text-[15px] leading-5 text-[#5c626c] dark:text-[color:var(--app-secondary-label)]">
                      Connect contacts to see who is already here.
                    </p>
                    <button data-location-type-role="primary-action"
                      type="button"
                      className="min-h-11 px-2 text-[15px] font-semibold text-[color:var(--app-accent-deep)] disabled:opacity-50 dark:text-[color:var(--app-accent-bright)]"
                      onClick={onSync}
                      disabled={leaving}
                    >
                      Check my contacts
                    </button>
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
                const connected =
                  match.connectionStatus === "auto_connected" ||
                  match.connectionStatus === "already_connected";
                const requestRequired =
                  match.connectionStatus === "request_required";
                return (
                  <li
                    key={match.userId}
                    className="flex items-center justify-between gap-3 rounded-2xl border border-[#e4e6e9] bg-white px-4 py-3 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]"
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[15px] font-medium text-[#151b26] dark:text-[color:var(--app-label)]">
                      <span data-location-type-role="row-description" className="min-w-0 truncate">
                        {match.displayName}
                      </span>
                      {connected ? <ContactSourceBadge /> : null}
                    </span>
                    {requestRequired ? (
                      <MorphyButton
                        type="button"
                        variant="none"
                        effect="fade"
                        size="compact"
                        onClick={() => onAdd(match.userId)}
                        disabled={added || adding || leaving}
                        aria-busy={adding || undefined}
                        className={cn(LOCATION_CONNECT_ACTION_TARGET_CLASSNAME, "shrink-0")}
                      >
                        <span data-location-type-role="compact-action" className={cn(
                          LOCATION_CONNECT_ACTION_PILL_CLASSNAME,
                          added && "!border-[color:var(--app-card-border-standard)] !text-[color:var(--app-secondary-label)]",
                        )}>
                          {adding ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                          ) : added ? (
                            <Check className="h-4 w-4" strokeWidth={2.5} aria-hidden="true" />
                          ) : null}
                          {added ? "Requested" : adding ? "Sending" : "Request"}
                        </span>
                      </MorphyButton>
                    ) : (
                      <span data-location-type-role="helper" className="inline-flex shrink-0 items-center gap-1.5 text-[13px] font-semibold text-[#5c626c] dark:text-[#aeb8c7]">
                        {connected ? (
                          <Check className="h-4 w-4 text-emerald-600" />
                        ) : null}
                        {match.connectionStatus === "auto_connected"
                          ? "Connected now"
                          : match.connectionStatus === "already_connected"
                            ? "Already connected"
                            : "Kept disconnected"}
                      </span>
                    )}
                  </li>
                );
              })}
              {visibleMatches.length < matches.length ? (
                <li className="flex flex-col items-center gap-2 pt-2">
                  <span data-location-type-role="helper" className="text-xs text-[#73777f]" aria-live="polite">
                    Showing {visibleMatches.length} of {matches.length}
                  </span>
                  <button data-location-type-role="primary-action"
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
              {state.summary || state.partial ? (
                <li data-location-type-role="row-description" className="rounded-2xl bg-amber-500/10 px-4 py-3 text-sm leading-5 text-foreground">
                  {state.summary ||
                    "Only part of your contact list was checked."}
                </li>
              ) : null}
              <li className="flex justify-center pt-2">
                <button data-location-type-role="utility-action"
                  type="button"
                  onClick={onSync}
                  disabled={leaving}
                  className="press-scale min-h-11 rounded-full border border-[#d5d9df] bg-white px-5 text-sm font-bold text-[#1f2b3d] disabled:opacity-50 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                >
                  Sync again
                </button>
              </li>
            </ul>
          ) : null}

          {state.kind === "none" ? (
            <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 text-center dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]">
              <p data-location-type-role="row-description" className="text-[15px] leading-5 text-[#5c626c] dark:text-[color:var(--app-secondary-label)]">
                No eligible contacts matched.
              </p>
              <p data-location-type-role="row-description" className="mt-2 text-[13px] leading-5 text-[#96999e] dark:text-[color:var(--app-secondary-label)]">
                {state.partial
                  ? state.summary ||
                    "Only part of your contact list was checked. "
                  : "ONE users with an exact verified phone match connect automatically unless they are hidden, opted out, or were previously disconnected. "}
                Use the circle code above to invite anyone you want here.
              </p>
              <div className="mt-4 flex flex-col items-center gap-2">
                {showGoogleAccountSwitcher && onSyncDifferentGoogleAccount ? (
                  <button data-location-type-role="primary-action"
                    type="button"
                    onClick={onSyncDifferentGoogleAccount}
                    disabled={leaving}
                    aria-label="Check a different Google account"
                    className="press-scale inline-flex min-h-11 items-center justify-center rounded-full bg-[color:var(--app-accent)] px-5 text-sm font-bold text-[color:var(--app-accent-fg)] disabled:opacity-50"
                  >
                    Use a different Google account
                  </button>
                ) : null}
                <button data-location-type-role="utility-action"
                  type="button"
                  onClick={onSync}
                  disabled={leaving}
                  className="press-scale inline-flex min-h-11 items-center justify-center rounded-full border border-[#d5d9df] bg-white px-5 text-sm font-bold text-[#1f2b3d] disabled:opacity-50 dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                >
                  Sync again
                </button>
              </div>
            </div>
          ) : null}

          {state.kind === "failed" ? (
            <div className="mt-7 rounded-[20px] border border-[#e4e6e9] bg-[#f8f9fb] p-6 text-center dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-primary-surface)]">
              <p data-location-type-role="row-description" className="text-[15px] leading-5 text-[#5c626c] dark:text-[color:var(--app-secondary-label)]">
                {state.message}
              </p>
              {state.canOpenSettings ? (
                <button data-location-type-role="utility-action"
                  type="button"
                  onClick={onOpenSettings}
                  className="press-scale mt-4 inline-flex min-h-11 items-center justify-center rounded-full border border-[#d5d9df] bg-white px-5 text-sm font-bold text-[#1f2b3d] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                >
                  Open Settings
                </button>
              ) : null}
              {!state.canOpenSettings || source === "google" ? (
                <button data-location-type-role="utility-action"
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
  completeControlId,
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
  showGoogleAccountSwitcher = false,
  onSyncDifferentGoogleAccount,
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
  completeControlId?: string;
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
  contactState: OnboardingContactState;
  contactsSource: "device" | "google";
  contactMatches: OnboardingContactMatch[];
  addedContactIds: string[];
  addingContactIds: string[];
  onSyncContacts: () => void;
  onAddContact: (userId: string) => void;
  onOpenContactSettings: () => void;
  showGoogleAccountSwitcher?: boolean;
  onSyncDifferentGoogleAccount?: () => void;
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
          disabled={leaving || completing || joinBusy || contactState.kind === "busy" || addingContactIds.length > 0}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-white/85 text-[#1f2b3d] shadow-[0_2px_10px_rgba(24,57,91,0.14)] backdrop-blur-sm dark:bg-[color:var(--app-glass-surface)] dark:text-[color:var(--app-label)] dark:shadow-[var(--app-glass-shadow)]"
          aria-label="Go back"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <span className="rounded-[14px] bg-white/90 px-3 py-2 shadow-[0_2px_10px_rgba(24,57,91,0.14)] backdrop-blur-sm dark:bg-[color:var(--app-glass-surface)] dark:shadow-[var(--app-glass-shadow)]">
          <OnboardingStepper
            steps={ONE_LOCATION_ONBOARDING_STEPS}
            currentIndex={2}
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
          <h1 data-location-type-role="flow-title"
            ref={headingRef}
            tabIndex={-1}
            className="ui-text-page-title pb-1 text-[#151b26] outline-none dark:!text-[color:var(--app-label)]"
            data-one-ready-title
          >
            {mapPoint ? "You're on the map." : "You're all set."}
          </h1>

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
              <div data-location-type-role="row-description" className="flex min-h-24 items-center justify-center gap-2 text-sm text-[#777d86] dark:text-[color:var(--app-secondary-label)]">
                <Loader2 className="h-5 w-5 animate-spin" /> Getting your code
              </div>
            ) : error ? (
              <div className="flex min-h-24 flex-col items-center justify-center gap-3 text-center">
                <p data-location-type-role="row-description" className="max-w-[260px] text-sm leading-5 text-[#6f7580] dark:text-[color:var(--app-secondary-label)]">
                  {error}
                </p>
                <Button data-location-type-role="compact-action"
                  type="button"
                  size="compact"
                  onClick={onRetry}
                  className="bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                >
                  Try again
                </Button>
              </div>
            ) : invite ? (
              <>
                {/* The circle's name, not a sentence wrapped around it. "Bring
                  your people to Ankit's Circle" spent five words introducing
                  the two things directly under it -- a code and a Share
                  button -- which the card's own shape already introduces. */}
                <p data-location-type-role="row-title" className="text-[13px] font-medium leading-[18px] text-[#6E6E73] dark:text-[color:var(--app-secondary-label)]">
                  {invite.circleName}
                </p>
                <p data-location-type-exception="invitation-code"
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
                <p data-location-type-role="row-description" className="mt-2 text-[12px] leading-[18px] text-[#96999e] dark:text-[color:var(--app-secondary-label)]">
                  Expires in 72 hours
                </p>
                <div className="mt-4 grid grid-cols-2 items-center gap-2.5">
                  <Button data-location-type-role="utility-action"
                    type="button"
                    variant="outline"
                    size="standard"
                    onClick={onCopy}
                    className="border-[#d5d9df] bg-white text-[#1f2b3d] dark:border-[color:var(--app-separator)] dark:bg-[color:var(--app-secondary-surface)] dark:text-[color:var(--app-label)]"
                  >
                    {copied ? (
                      <Check className="h-5 w-5" strokeWidth={2.5} />
                    ) : (
                      <Copy className="h-5 w-5" strokeWidth={2} />
                    )}
                    {copied ? "Copied" : "Copy"}
                  </Button>

                  <Button data-location-type-role="primary-action"
                    type="button"
                    size="standard"
                    onClick={onShare}
                    className="bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                  >
                    <Share2 onAccent className="h-5 w-5" strokeWidth={2} />
                    Share
                  </Button>
                </div>
              </>
            ) : (
              <p data-location-type-role="row-description" className="flex min-h-24 items-center justify-center px-2 text-center text-sm leading-5 text-[#6f7580] dark:text-[color:var(--app-secondary-label)]">
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
                <span data-location-type-role="utility-action" className="min-w-0 flex-1">Join with a code</span>
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
                    <p data-location-type-role="status"
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
                      <p data-location-type-role="row-title" className="text-[15px] font-bold leading-5 text-[#151b26] dark:text-[color:var(--app-label)]">
                        {joinPreview.name}
                      </p>
                      <p data-location-type-role="row-description" className="mt-1 text-[13px] leading-[18px] text-[#73777f] dark:text-[color:var(--app-secondary-label)]">
                        {joinPreview.ownerDisplayName} &middot;{" "}
                        {joinPreview.memberCount}{" "}
                        {joinPreview.memberCount === 1 ? "person" : "people"}
                      </p>
                      {!joinPreview.alreadyMember ? (
                        <button data-location-type-role="primary-action"
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
                        <p data-location-type-role="row-description" className="mt-3 text-[13px] text-muted-foreground">
                          Already in this circle.
                        </p>
                      )}
                      <button data-location-type-role="primary-action"
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
                      <input data-location-type-exception="invitation-code"
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
                      <button data-location-type-role="utility-action"
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
                    <p data-location-type-role="row-description"
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
                <span data-location-type-role="utility-action" className="min-w-0 flex-1">Find contacts</span>
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
                    showGoogleAccountSwitcher={showGoogleAccountSwitcher}
                    onSyncDifferentGoogleAccount={onSyncDifferentGoogleAccount}
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
            <p data-location-type-role="status"
              className="mb-3 text-center text-[13px] leading-5 text-[#96999e] dark:text-[color:var(--app-secondary-label)]"
              role="status"
            >
              That didn&apos;t save. Tap again.
            </p>
          ) : null}
          {/* Always the completion CTA. A code that failed to load is not a
              reason to record the whole capability as skipped -- the person
              finished the introduction, so opening Location is the honest
              outcome. Retrying the code lives inside the card above. */}
          <PrimaryButton
            voiceControlId={completeControlId}
            className="mx-auto flex max-w-[244px]"
            onClick={onContinue}
            busy={completing}
            disabled={leaving}
          >
            {completeLabel}
          </PrimaryButton>
        </footer>
      </div>

      <style>{`
        [data-one-ready-title] { animation: oneReadyRise 150ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        [data-one-ready-code] { animation: oneReadyRise 150ms cubic-bezier(0.22, 1, 0.36, 1) both; }
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

function initialScreen(): OnboardingScreen {
  return "features";
}

export function OneLocationOnboardingFlow({
  startAt,
  activeScreen,
  onScreenChange,
  currentUserName,
  nativeTest,
  onBack,
  onComplete,
  onSkip = onComplete,
  completeLabel = "Open One Location",
  completeControlId,
  mapPoint = null,
  contactsStepAvailable = true,
  contactsSource = "device",
  onPreparePlace,
  onSyncOnboardingContacts,
  contactSyncResult,
  showGoogleAccountSwitcher = false,
  onAddOnboardingContact,
  onOpenContactSettings,
  onPreviewCircleCode,
  onAcceptCircleCode,
  onPrepareOnboardingCircleInvite,
  onCopyOnboardingCircleCode,
  onShareOnboardingCircleCode,
}: OneLocationOnboardingFlowProps) {
  // Onboarding owns the whole screen: no tab bar, top bar or agent dock under it.
  useSessionChromeSuppression(true);

  // Subscribe to an existing fix without requesting permission or starting GPS.
  const { snapshot: deviceSnapshot } = useCurrentLocation({ auto: false });

  const finaleMapPoint = useMemo(
    () =>
      resolveOnboardingFinaleMapPoint({
        onboarding: mapPoint,
        device: deviceSnapshot,
      }),
    [deviceSnapshot, mapPoint],
  );

  const [internalScreen, setInternalScreen] = useState<OnboardingScreen>(() =>
    initialScreen(),
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
  const [contactState, setContactState] = useState<OnboardingContactState>({
    kind: "idle",
  });
  // Mirror for the sync handler: dismissing the chooser must restore the
  // exact state the run started from, which the busy state has covered by
  // the time a cancellation lands.
  const contactStateRef = useRef(contactState);
  contactStateRef.current = contactState;
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
  const [placePreparing, setPlacePreparing] = useState(false);
  const placePreparingRef = useRef(false);
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
  const completionInFlightRef = useRef(false);

  useEffect(() => {
    if (activeScreen) return;
    setInternalScreen(initialScreen());
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

  const canOpenContactSettings = Boolean(onOpenContactSettings);
  const applyContactSyncResult = useCallback(
    (result: OnboardingContactSyncResult) => {
      if (result.status === "cancelled") {
        setContactState({ kind: "idle" });
        return;
      }
      if (result.status === "matched" && result.matches.length > 0) {
        setContactMatches(result.matches);
        setContactState({
          kind: "matched",
          partial: Boolean(result.partial),
          summary: result.summary,
        });
        return;
      }
      // A declined permission resolves rather than throws, and must not be
      // reported as "nobody matched" -- that would hide the one thing that
      // could fix it, and on iOS the decline is otherwise permanent.
      if (result.status === "failed") {
        setContactState({
          kind: "failed",
          message: result.message,
          canOpenSettings: result.canOpenSettings && canOpenContactSettings,
        });
        return;
      }
      // "matched" with an empty list lands here too, which is the same outcome
      // as "none" from the person's point of view.
      setContactState({
        kind: "none",
        partial: result.status === "none" ? result.partial : false,
        summary: result.status === "none" ? result.summary : undefined,
      });
    },
    [canOpenContactSettings],
  );

  useEffect(() => {
    if (contactSyncResult) applyContactSyncResult(contactSyncResult);
  }, [applyContactSyncResult, contactSyncResult]);

  const contactSyncInFlightRef = useRef(false);
  const handleSyncContacts = useCallback(
    async (chooseGoogleAccount = false) => {
      if (!onSyncOnboardingContacts || contactSyncInFlightRef.current) return;
      contactSyncInFlightRef.current = true;
      // Dismissing the Google chooser or consent sheet is not a reset: a
      // cancellation restores exactly this state instead of idling.
      const resumeState =
        contactStateRef.current.kind === "matched" ||
        contactStateRef.current.kind === "none"
          ? contactStateRef.current
          : null;
      setContactState({ kind: "busy" });
      try {
        const result = await onSyncOnboardingContacts(
          chooseGoogleAccount ? { chooseGoogleAccount: true } : undefined,
        );
        if (result.status === "cancelled") {
          setContactState((current) =>
            current.kind === "busy"
              ? (resumeState ?? { kind: "idle" })
              : current,
          );
          return;
        }
        applyContactSyncResult(result);
      } catch (error) {
        setContactState({
          kind: "failed",
          message:
            error instanceof Error && error.message
              ? error.message
              : "We couldn't check your contacts. You can try again later.",
          canOpenSettings: canOpenContactSettings,
        });
      } finally {
        contactSyncInFlightRef.current = false;
      }
    },
    [applyContactSyncResult, canOpenContactSettings, onSyncOnboardingContacts],
  );

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

  const continueFromFeatures = () => {
    if (leaving || placePreparingRef.current) return;
    if (!onPreparePlace) {
      setScreen("ready");
      return;
    }
    placePreparingRef.current = true;
    setPlacePreparing(true);
    void (async () => {
      let opened = false;
      try {
        opened = (await onPreparePlace()) === true;
      } catch {
        opened = false;
      } finally {
        placePreparingRef.current = false;
        setPlacePreparing(false);
      }
      setScreen(opened ? "place" : "ready");
    })();
  };

  // All Back surfaces unwind the same local flow, including native Back and
  // legacy/controlled entries that start directly on the feature screen.
  const handleFlowBack = () => {
    if (leaving || placePreparing || completionBusy || joinBusy || contactState.kind === "busy" || addingContactIds.length > 0) return true;
    if (screen === "features") {
      void runBack();
    } else if (screen === "ready" && activeReadyDisclosure) {
      setActiveReadyDisclosure(null);
    } else {
      setScreen("features");
    }
    return true;
  };
  useBackLayer(nativeTest.routeId, activeReadyDisclosure ? 2 : 1, handleFlowBack);

  return (
    <main
      // Onboarding is modal; nothing from the app shell belongs over it. Keep
      // it above elevated Talk to One / bottom-nav states without touching those
      // global controls.
      className="fixed inset-0 z-[9000] flex h-dvh min-h-[100svh] w-full items-stretch justify-center overflow-hidden bg-[color:var(--app-grouped-background)] text-[#171d28] dark:text-[color:var(--app-label)]"
      data-one-onboarding-design="location-agent-v3"
      data-location-type-scale="connect"
      data-location-type-context="flow"
      data-no-route-swipe
      data-testid="one-location-onboarding"
      data-location-onboarding-screen={screen}
    >
      <NativeTestBeacon {...nativeTest} />
      <section
        className={cn(
          "flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[color:var(--app-grouped-background)]",
          // Feature content keeps a responsive rail; Ready owns its panel.
          "max-w-none",
        )}
        data-testid={LOCATION_SCREEN_TEST_IDS[screen]}
      >
        {screen === "features" ? (
          <FeaturesScreen
            onBack={handleFlowBack}
            onSkip={() => void runSkip()}
            leaving={leaving}
            continueBusy={placePreparing}
            onContinue={continueFromFeatures}
          />
        ) : null}
        {screen === "ready" ? (
          <ReadyScreen
            currentUserName={currentUserName}
            mapPoint={finaleMapPoint}
            mapEmptyLabel="Turn on Location when you're ready."
            invite={circleInvite}
            loading={circleInviteLoading}
            error={circleInviteError}
            copied={circleInviteCopied}
            onRetry={() => void prepareCircleInvite()}
            onCopy={handleCopyCircleInvite}
            onShare={handleShareCircleInvite}
            onBack={handleFlowBack}
            onContinue={finishFromInvite}
            leaving={leaving}
            completeLabel={completeLabel}
            completeControlId={completeControlId}
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
            onSyncDifferentGoogleAccount={() => void handleSyncContacts(true)}
            onAddContact={handleAddContact}
            onOpenContactSettings={() =>
              onOpenContactSettings?.(() => void handleSyncContacts())
            }
            showGoogleAccountSwitcher={showGoogleAccountSwitcher}
          />
        ) : null}
      </section>
    </main>
  );
}
