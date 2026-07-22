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
  onComplete: () => void | Promise<void>;
  onSkip?: () => void | Promise<void>;
  requireLocationToComplete?: boolean;
};

const TEAM_AVATAR_SOURCES = [
  "/one-location/onboarding/akshat.webp",
  "/one-location/onboarding/neelesh.webp",
  "/one-location/onboarding/ankit.webp",
  "/one-location/onboarding/kushal.webp",
] as const;

const ONBOARDING_IMAGE_SOURCES = [
  "/one-location/onboarding/il-car.png",
  "/one-location/onboarding/il-pin.png",
  "/one-location/onboarding/il-shield.png",
  ...TEAM_AVATAR_SOURCES,
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
      ? "h-[72px] w-[72px] text-xl"
      : size === "sm"
        ? "h-9 w-9 text-xs"
        : "h-14 w-14 text-sm";

  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border-[3px] border-white bg-[#dce8f6] font-bold text-[#21364d] shadow-[0_8px_22px_rgba(24,57,91,0.18)] dark:border-[#dce7f6]",
        sizeClass,
      )}
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

function TeamAvatar({
  index,
  size = "sm",
  shape = "circle",
}: {
  index: number;
  size?: "sm" | "lg";
  shape?: "circle" | "portrait";
}) {
  const src = TEAM_AVATAR_SOURCES[index % TEAM_AVATAR_SOURCES.length]!;
  return (
    <span
      className={cn(
        "block shrink-0 overflow-hidden bg-[#dce8f6]",
        shape === "portrait"
          ? "rounded-[13px]"
          : "rounded-full border-[3px] border-white shadow-[0_8px_22px_rgba(24,57,91,0.18)]",
        size === "lg" ? "h-[58px] w-[58px]" : "h-8 w-8",
      )}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Local static team art must render in Capacitor static export. */}
      <img
        src={src}
        alt=""
        loading="eager"
        decoding="async"
        fetchPriority="high"
        className="h-full w-full object-cover"
      />
    </span>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled = false,
  busy = false,
  inverse = false,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  inverse?: boolean;
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
      )}
    >
      {busy ? (
        <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />
      ) : null}
      {children}
    </button>
  );
}

function WelcomeRadar() {
  const contacts = [
    "left-1/2 top-[8%] -translate-x-1/2",
    "bottom-[12%] left-[9%]",
    "bottom-[22%] right-[7%]",
  ];

  return (
    <div
      className="relative mx-auto aspect-square w-[min(82vw,38dvh,350px)] overflow-hidden"
      aria-hidden="true"
    >
      {["inset-[4%]", "inset-[20%]", "inset-[36%]"].map((position, index) => (
        <span
          key={position}
          className={cn(
            "absolute rounded-full border border-white/35",
            position,
            index === 0 && "[animation:oneWelcomeRing_3s_ease-in-out_infinite]",
          )}
        />
      ))}
      <span className="absolute left-1/2 top-1/2 flex h-14 w-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[5px] border-white/80 bg-white/20">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[color:var(--app-accent)]">
          <MapPin className="h-5 w-5 fill-current/10" strokeWidth={2.5} />
        </span>
      </span>
      {contacts.map((position, index) => (
        <span key={position} className={cn("absolute", position)}>
          <span className="block rounded-[18px] bg-white p-1 shadow-[0_12px_28px_rgba(0,40,100,0.28)]">
            <TeamAvatar index={index} size="lg" shape="portrait" />
          </span>
          <span className="absolute -right-1 -top-1 h-5 w-5 rounded-full border-[3px] border-white bg-[#34c759]" />
        </span>
      ))}
      <style>{`
        @keyframes oneWelcomeRing { 0%, 100% { opacity: .32; } 50% { opacity: .78; } }
        @media (prefers-reduced-motion: reduce) { [data-one-onboarding-motion] { animation: none !important; } }
      `}</style>
    </div>
  );
}

function WelcomeScreen({
  onBack,
  onStart,
  leaving,
}: {
  onBack: () => void;
  onStart: () => void;
  leaving: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[color:var(--app-accent)] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] text-white dark:bg-[#071d39]">
      <header className="flex h-16 shrink-0 items-center pt-2">
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
      </header>
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0 text-center">
          <p className="inline-flex items-center gap-2 text-[19px] font-bold">
            <MapPin
              className="h-5 w-5"
              strokeWidth={2.5}
              data-testid="location-agent-heading-icon"
            />
            Location Agent
          </p>
          <h1 className="mx-auto mt-7 max-w-[400px] text-[clamp(32px,5dvh,40px)] font-bold leading-[1.08] tracking-normal">
            The people you love.
            <br />
            Always in reach.
          </h1>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center py-3">
          <WelcomeRadar />
        </div>
        <div className="shrink-0">
          <PrimaryButton inverse onClick={onStart}>
            Get started
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}

type UseCaseCardProps = {
  tag: string;
  title: string;
  body: string;
  imageSrc: string;
  imageClassName?: string;
  alertText: string;
  avatarIndexes: number[];
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

function UseCaseCard({
  tag,
  title,
  body,
  imageSrc,
  imageClassName,
  alertText,
  avatarIndexes,
  tone,
  testId,
}: UseCaseCardProps) {
  const colors = USE_CASE_TONES[tone];
  return (
    <article
      className="relative min-h-0 overflow-hidden rounded-[22px] border border-black/[0.04] bg-[#fbfcfe] shadow-[0_8px_26px_rgba(21,41,70,0.08)] dark:border-white/[0.08] dark:bg-[#171d27] dark:shadow-none"
      data-testid={testId}
      data-one-use-case-card
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", colors.line)} />
      <div
        className="relative z-10 flex h-full w-[59%] min-w-0 flex-col justify-center py-3 pl-5 pr-1"
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
        <h2
          className="mt-2 text-[clamp(17px,2.7dvh,21px)] font-bold leading-tight text-[#091126] dark:text-white"
          data-one-use-case-title
        >
          {title}
        </h2>
        <p
          className="mt-1 text-[clamp(12px,1.8dvh,14px)] leading-[1.35] text-[#777d88] dark:text-[#aeb8c7]"
          data-one-use-case-body
        >
          {body}
        </p>
      </div>
      <div className="absolute inset-y-0 right-0 w-[49%] overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- Supplied onboarding art must render in Capacitor static export. */}
        <img
          src={imageSrc}
          alt=""
          loading="eager"
          decoding="async"
          fetchPriority="high"
          className={cn(
            "h-full w-full object-contain [mask-image:radial-gradient(ellipse_at_center,black_52%,transparent_96%)] dark:brightness-[0.72] dark:contrast-125 dark:saturate-125",
            imageClassName,
          )}
        />
        <span
          className="absolute bottom-2 right-2 flex max-w-[96%] items-center gap-1 rounded-full bg-white/95 py-1 pl-1 pr-2 text-[9px] font-bold text-[#151b26] shadow-[0_5px_16px_rgba(22,35,58,0.16)] dark:bg-[#f4f7fb]"
          data-one-use-case-alert
        >
          <span className="flex -space-x-2">
            {avatarIndexes.map((avatarIndex) => (
              <TeamAvatar key={avatarIndex} index={avatarIndex} />
            ))}
          </span>
          <span className="truncate">{alertText}</span>
        </span>
      </div>
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
  onContinue,
}: {
  locationGranted: boolean;
  notificationsGranted: boolean;
  locationBusy: boolean;
  notificationBusy: boolean;
  requireLocationToContinue: boolean;
  onBack: () => void;
  onSkip: () => void;
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
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-white px-5 pb-[calc(env(safe-area-inset-bottom,0px)+16px)] dark:bg-[#0c1017]">
      <header className="flex h-14 shrink-0 items-center justify-between">
        <button
          type="button"
          onClick={onBack}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] text-[#1f2b3d] dark:bg-white/[0.08] dark:text-white"
          aria-label="Go back"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
        <button
          type="button"
          onClick={onSkip}
          disabled={locationBusy}
          className="min-h-11 rounded-full px-1 text-[16px] font-bold text-[color:var(--app-accent-deep)] disabled:opacity-50 dark:text-[color:var(--app-accent-bright)]"
        >
          Skip
        </button>
      </header>
      <h1
        className="shrink-0 text-[clamp(31px,5dvh,40px)] font-bold leading-[1.02] tracking-normal text-[#091126] dark:text-[#f6f8fc]"
        data-one-feature-heading
      >
        When it matters,
        <br />
        your people know.
      </h1>
      <div
        className="mt-4 grid min-h-0 flex-1 grid-rows-3 gap-3"
        data-one-feature-grid
      >
        <UseCaseCard
          tag="SMS"
          title="Need help fast?"
          body="One hold texts your live location."
          imageSrc="/one-location/onboarding/il-shield.png"
          alertText="Ankit & Neelesh alerted"
          avatarIndexes={[2, 1]}
          tone="danger"
          testId="location-use-case-sos"
        />
        <UseCaseCard
          tag="Check in"
          title="Meeting a friend?"
          body="Share where you are so they find you fast."
          imageSrc="/one-location/onboarding/il-pin.png"
          alertText="Kushal is joining you"
          avatarIndexes={[3]}
          tone="success"
          testId="location-use-case-checkin"
        />
        <UseCaseCard
          tag="Live trip"
          title="Riding home late?"
          body="Share your live trip and ETA."
          imageSrc="/one-location/onboarding/il-car.png"
          imageClassName="object-cover object-center"
          alertText="Jhumma is on her way"
          avatarIndexes={[0]}
          tone="info"
          testId="location-use-case-trip"
        />
      </div>
      <p
        className="h-7 shrink-0 pt-2 text-center text-[11px] font-semibold leading-4 text-[#7d838d] dark:text-[#9ba7b7]"
        aria-live="polite"
      >
        {status}
      </p>
      <div className="mt-2 shrink-0">
        <PrimaryButton
          onClick={onContinue}
          busy={permissionBusy}
          disabled={permissionBusy}
        >
          {waitingForLocation ? "Allow location" : "Continue"}
        </PrimaryButton>
      </div>
      <style>{`
        @media (max-height: 700px) {
          [data-one-feature-heading] { font-size: 28px; }
          [data-one-feature-grid] { margin-top: 8px; gap: 8px; }
          [data-one-use-case-card] { border-radius: 18px; }
          [data-one-use-case-copy] { padding: 6px 4px 6px 16px; }
          [data-one-use-case-tag] { padding: 2px 9px; font-size: 10px; }
          [data-one-use-case-title] { margin-top: 3px; font-size: 15px; }
          [data-one-use-case-body] { margin-top: 1px; font-size: 11px; line-height: 1.25; }
          [data-one-use-case-alert] { bottom: 4px; right: 4px; }
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
      <header className="flex h-16 shrink-0 items-center px-5 pt-2">
        <button
          type="button"
          onClick={onBack}
          className="press-scale flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] text-[#1f2b3d] dark:bg-white/[0.08] dark:text-white"
          aria-label="Go back"
        >
          <ArrowLeft className="h-6 w-6" />
        </button>
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
                No recommendations yet. You can add people later from Connect.
              </p>
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
}: {
  currentUserName: string;
  currentUserPhotoUrl?: string | null;
  members: CircleMember[];
  requestsSending: boolean;
  failedCount: number;
  settlementRetryCount: number;
  onBack: () => void;
}) {
  const [messageIndex, setMessageIndex] = useState(0);
  const shown = members.slice(0, 4);
  const positions = [
    "left-1/2 top-[5%] -translate-x-1/2",
    "right-[4%] top-1/2 -translate-y-1/2",
    "bottom-[5%] left-1/2 -translate-x-1/2",
    "left-[4%] top-1/2 -translate-y-1/2",
  ];
  const messages =
    settlementRetryCount > 0
      ? [
          "Your circle is ready.",
          "One is finishing the secure setup...",
          "Keeping everyone together while we reconnect.",
        ]
      : [
          requestsSending
            ? "Sending your invitations securely..."
            : "Bringing your trusted people together...",
          `${members.length} ${members.length === 1 ? "person" : "people"} in your private circle.`,
          failedCount > 0
            ? `${failedCount} invitation will be available to retry in Connect.`
            : "Nothing is shared until you choose it.",
          "Your circle is ready.",
        ];

  useEffect(() => {
    setMessageIndex(0);
    const timer = window.setInterval(() => {
      setMessageIndex((current) => Math.min(current + 1, messages.length - 1));
    }, 900);
    return () => window.clearInterval(timer);
  }, [messages.length, settlementRetryCount]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-white px-6 pb-[calc(env(safe-area-inset-bottom,0px)+18px)] pt-[max(env(safe-area-inset-top,0px),22px)] dark:bg-[#0c1017]">
      <button
        type="button"
        onClick={onBack}
        className="press-scale absolute left-5 top-[max(env(safe-area-inset-top,0px),14px)] z-20 flex h-11 w-11 items-center justify-center rounded-full bg-black/[0.05] text-[#1f2b3d] dark:bg-white/[0.08] dark:text-white"
        aria-label="Go back"
      >
        <ArrowLeft className="h-6 w-6" />
      </button>
      <div className="shrink-0 text-center">
        <p className="text-[13px] font-bold uppercase text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]">
          Location Agent
        </p>
        <h1 className="mx-auto mt-3 max-w-[400px] text-[clamp(32px,5dvh,40px)] font-bold leading-[1.04] text-[#151b26] dark:text-[#f5f7fb]">
          Your circle,
          <br />
          your choice
        </h1>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div
          className="relative aspect-square w-[min(88vw,48dvh,390px)] overflow-hidden"
          aria-label="Your private circle"
        >
          {["inset-[8%]", "inset-[22%]", "inset-[36%]"].map(
            (position, index) => (
              <span
                key={position}
                data-one-onboarding-motion
                className={cn(
                  "absolute rounded-full border border-[color:var(--app-accent-border)]",
                  position,
                  "[animation:oneCirclePulse_2.8s_ease-out_infinite]",
                )}
                style={{ animationDelay: `${index * 380}ms` }}
              />
            ),
          )}
          <span className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <Avatar
              name={currentUserName}
              photoUrl={currentUserPhotoUrl}
              size="lg"
            />
            <span className="absolute -inset-1 -z-10 rounded-full border-[3px] border-[color:var(--app-accent)] shadow-[0_0_28px_var(--app-accent-ring)]" />
          </span>
          {shown.map((member, index) => (
            <span
              key={member.userId}
              className={cn(
                "absolute z-10 flex flex-col items-center",
                positions[index],
              )}
            >
              <Avatar name={member.displayName} photoUrl={member.photoUrl} />
              <span className="mt-1 max-w-20 truncate text-[11px] font-bold text-[#202736] dark:text-[#e9eef7]">
                {member.displayName.split(" ")[0]}
              </span>
              {member.status === "pending" ? (
                <span className="mt-0.5 rounded-full bg-[#fff3d9] px-2 py-0.5 text-[9px] font-semibold text-[#986a16] dark:bg-[#4a3718] dark:text-[#ffd98a]">
                  Pending
                </span>
              ) : null}
            </span>
          ))}
        </div>
      </div>
      <div
        className="flex h-20 shrink-0 items-center justify-center"
        aria-live="polite"
      >
        <p
          key={`${settlementRetryCount}-${messageIndex}`}
          className="motion-step-enter max-w-[360px] text-center text-[16px] font-semibold leading-6 text-[#69717d] dark:text-[#aeb8c7]"
        >
          {messages[messageIndex]}
        </p>
      </div>
      <div className="flex h-8 shrink-0 items-center justify-center gap-2 text-[12px] font-semibold text-[#8b919a] dark:text-[#8794a6]">
        <ShieldCheck className="h-4 w-4 text-[color:var(--app-accent-deep)] dark:text-[color:var(--app-accent-bright)]" />
        Private by default
      </div>
      <style>{`
        @keyframes oneCirclePulse {
          0% { opacity: .2; transform: scale(.88); }
          55% { opacity: .72; }
          100% { opacity: .08; transform: scale(1.12); }
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
  onRequestNotifications,
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
            onBack={() => void runSkip()}
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
            onSkip={continueFromFeatures}
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
            onBack={() => setScreen("people")}
          />
        ) : null}
      </section>
    </main>
  );
}
