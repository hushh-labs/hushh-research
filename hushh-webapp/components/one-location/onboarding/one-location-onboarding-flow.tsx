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
  onComplete: () => void;
};

const FEATURE_SCREENS: OnboardingScreen[] = ["arrival", "checkin", "sos"];

// All static onboarding art. Preloaded on mount so screen-to-screen
// transitions show the illustration instantly instead of fetching it lazily
// the first time each feature screen renders (which caused visible pop-in).
const ONBOARDING_IMAGE_SOURCES = [
  "/one-location/onboarding/arrival-backpack.webp",
  "/one-location/onboarding/checkin-pin.webp",
  "/one-location/onboarding/sos-shield.webp",
  "/one-location/onboarding/contact-avatars.webp",
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
            light ? "rounded-full bg-white/15 text-white" : "text-[#1f2b3d]",
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
            light ? "text-white" : "text-[#1f2b3d]",
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
          ? "bg-white text-[#087cf0]"
          : "bg-[#087cf0] text-white hover:bg-[#006fdc]",
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
            index === activeIndex ? "w-7 bg-[#26334f]" : "w-2 bg-[#c9cbd0]",
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
  const positions = [
    "left-1/2 top-[3%] -translate-x-1/2",
    "left-[9%] bottom-[15%]",
    "right-[9%] bottom-[15%]",
  ];

  return (
    <div
      className="relative mx-auto aspect-square w-[min(72vw,32dvh,340px)]"
      aria-hidden="true"
    >
      {["inset-[6%]", "inset-[22%]", "inset-[38%]"].map((position) => (
        <span
          key={position}
          className={cn("absolute rounded-full border border-white/28", position)}
        />
      ))}
      <span className="absolute inset-[48%] rounded-full bg-white/24 shadow-[0_0_38px_rgba(255,255,255,0.35)]" />
      <span className="absolute left-1/2 top-1/2 flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-white/70 bg-white text-[#087cf0] shadow-lg">
        <MapPin className="h-6 w-6 fill-[#087cf0]/12" />
      </span>
      {slots.map((person, index) => (
        <span
          key={person?.userId ?? `dummy-${index}`}
          className={cn("absolute", positions[index])}
        >
          {person ? (
            <Avatar name={safeName(person.displayName)} photoUrl={person.photoUrl} />
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

const DUMMY_AVATAR_POSITIONS = ["0% 0%", "100% 0%", "0% 100%", "100% 100%"];


function DummyContactAvatar({ index = 0, large = false }: { index?: number; large?: boolean }) {
  return (
    <span
      className={cn(
        "block shrink-0 rounded-full border-[3px] border-white bg-cover shadow-[0_8px_22px_rgba(24,57,91,0.18)]",
        large ? "h-16 w-16" : "h-11 w-11",
      )}
      style={{
        backgroundImage: "url('/one-location/onboarding/contact-avatars.webp')",
        backgroundPosition: DUMMY_AVATAR_POSITIONS[index % DUMMY_AVATAR_POSITIONS.length],
        backgroundSize: "200% 200%",
      }}
    />
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
  const name = safeName(person?.displayName, dummyIndex === 0 ? "Alex" : "Maya");
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

function ArrivalIllustration({ person }: { person?: DirectoryPerson }) {
  return (
    <div
      className="relative mx-auto h-[clamp(300px,48dvh,410px)] w-full max-w-[410px] overflow-hidden rounded-[24px] bg-transparent"
      data-testid="arrival-product-preview"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/arrival-backpack.webp"
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        style={{ objectPosition: "center 58%" }}
      />
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
      className="relative mx-auto h-[clamp(300px,48dvh,410px)] w-full max-w-[410px] overflow-hidden rounded-[24px] bg-transparent"
      data-testid="checkin-product-preview"

      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/checkin-pin.webp"
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        style={{ objectPosition: "center 58%" }}
      />
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
      className="relative mx-auto h-[clamp(300px,48dvh,410px)] w-full max-w-[410px] overflow-hidden bg-[#fbf8f3]"
      data-testid="sos-product-preview"
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Generated onboarding art must render in Capacitor static export. */}
      <img
        src="/one-location/onboarding/sos-shield.webp"
        alt=""
        className="absolute inset-0 h-full w-full object-cover"
        style={{ objectPosition: "center 55%" }}
      />
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
  const arrivalName = safeName(connectedPeople[0]?.displayName, "Alex");
  const checkinName = safeName(
    connectedPeople[1]?.displayName ?? connectedPeople[0]?.displayName,
    "Maya",
  );
  const content = {
    arrival: {
      title: "Know when they arrive",
      body: `"${arrivalName} arrived at Office" - get a quiet alert the moment your people reach the places that matter.`,
      visual: <ArrivalIllustration person={connectedPeople[0]} />,
      // Near-white cool grey — matches the arrival art's own light backdrop so
      // the illustration blends into the screen with no visible image edge.
      gradient: "from-[#f6f7fa] to-[#eef0f4]",
      cta: "Continue",
    },
    checkin: {
      title: "Let them know you're here",
      body: `"${checkinName} checked in" - one tap tells your trusted people where you are. No call needed.`,
      visual: <CheckinIllustration person={connectedPeople[1] ?? connectedPeople[0]} />,
      // Near-white warm — matches the check-in art's own light backdrop.
      gradient: "from-[#faf9f6] to-[#f2efea]",
      cta: "Continue",
    },
    sos: {
      title: "Help when it matters most",
      body: `"Help sent" - SOS shares your live location with selected people, instantly.`,
      visual: <SosIllustration people={connectedPeople} />,
      // Near-white warm — matches the SOS art's own light backdrop.
      gradient: "from-[#faf8f6] to-[#f2efea]",
      cta: "Create my circle",
    },

  }[screen];

  return (
    // Each onboarding slide uses a gradient tuned to its own illustration's
    // background tone (arrival = lavender behind the bag; check-in / SOS = warm
    // cream/peach) so the whole screen blends seamlessly with the art.
    <div className={cn("flex min-h-0 flex-1 flex-col bg-gradient-to-b", content.gradient)}>

      <TopNavigation onBack={onBack} onSkip={onSkip} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-3">
        <h1 className="mx-auto mb-3 max-w-[360px] text-center text-[31px] font-bold leading-[1.12] text-[#1e2a3d]">
          {content.title}
        </h1>
        <div className="my-auto">{content.visual}</div>

        <p className="mx-auto mt-3 max-w-[375px] text-center text-[17px] font-semibold leading-[1.45] text-[#263447]">
          {content.body}
        </p>
      </div>
      <footer className="shrink-0 px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] pt-2">
        <ProgressDots activeIndex={featureIndex} />
        <div className="mt-3">
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
          ? "border-[#0a84ff] bg-[#0a84ff] text-white"
          : "border-[#c9cdd3] bg-white text-transparent",
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
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <TopNavigation onBack={onBack} onSkip={onSkip} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 text-[38px] font-bold leading-[1.05] text-[#151b26]">Add people</h1>
        <p className="mt-3 text-[17px] leading-6 text-[#73777f]">
          Invite the people you want to keep connected with.
        </p>
        <h2 className="mt-9 text-[13px] font-bold uppercase text-[#96999e]">
          Recommended contacts
        </h2>

        <div className="mt-3 overflow-hidden rounded-[24px] bg-[#f8f9fb] px-4 shadow-[0_10px_30px_rgba(29,45,68,0.08)]">
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
                    index > 0 && "border-t border-[#e4e6e9]",
                  )}
                  aria-pressed={selected}
                  aria-label={`${selected ? "Remove" : "Add"} ${safeName(person.displayName)}${pending ? ", request pending" : ""}`}
                >
                  <Avatar name={safeName(person.displayName)} photoUrl={person.photoUrl} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[17px] font-bold text-[#171d28]">
                      {safeName(person.displayName)}
                    </span>
                    <span className="block truncate text-[14px] text-[#999ca2]">
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
        <p className="mx-auto mt-4 max-w-[350px] text-center text-[12px] leading-5 text-[#96999e]">
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
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <TopNavigation onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 text-[37px] font-bold leading-[1.08] text-[#151b26]">{title}</h1>
        <p className="mt-3 text-[17px] text-[#777b82]">{subtitle}</p>

        <div className="relative mx-auto mt-8 aspect-square w-full max-w-[390px]" aria-label="Your private circle">
          <span className="absolute inset-[12%] rounded-full border-2 border-dashed border-[#b9dcfb]" />
          <span className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
            <Avatar name={currentUserName} photoUrl={currentUserPhotoUrl} size="lg" />
            <span className="absolute -inset-1 -z-10 rounded-full border-[3px] border-[#087cf0] shadow-[0_0_25px_rgba(0,122,255,0.25)]" />
          </span>
          {shown.map((member, index) => (
            <span key={member.userId} className={cn("absolute flex flex-col items-center", positions[index])}>
              <Avatar name={member.displayName} photoUrl={member.photoUrl} />
              <span className="mt-1 max-w-20 truncate text-[12px] font-bold text-[#202736]">
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
              to the "Add people" screen to grow their circle. Tapping it routes
              back one step in the flow. */}
          <button
            type="button"
            onClick={onAddPeople}
            aria-label="Add people to your circle"
            className="absolute bottom-[8%] right-[9%] flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-[#83c4fb] bg-[#eaf5ff] text-[#087cf0] transition-transform active:scale-95 hover:bg-[#dbeeff]"
          >
            <UserPlus className="h-7 w-7" />
          </button>
        </div>


        <div className="mt-5 flex gap-4 rounded-[22px] bg-[#f5f8fb] px-5 py-5 shadow-[0_8px_24px_rgba(35,55,78,0.08)]">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#dff0ff] text-[#087cf0]">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <div>
            <h2 className="text-[16px] font-bold text-[#202736]">Your circle is private</h2>
            <p className="mt-1 text-[14px] leading-5 text-[#747981]">
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
        checked ? "bg-[#34c759]" : "bg-[#d9dde2]",
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
    <div className="flex min-h-[132px] items-start gap-4 border-b border-[#e9eaec] py-5 last:border-b-0">
      <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-[#f5f7fa] text-[#0784ee]">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-[17px] font-bold text-[#171d28]">{title}</h2>
        <p className="mt-1 text-[14px] leading-5 text-[#777c84]">{description}</p>
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
}: {
  canGoBack: boolean;
  locationPermission: HushhLocationPermissionState | null;
  notificationDeliveryMode: ConsentNotificationDeliveryMode;
  notificationBusy: boolean;
  locationBusy: boolean;
  onBack: () => void;
  onRequestLocation: () => Promise<void>;
  onRequestNotifications: () => Promise<void>;
  onComplete: () => void;
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
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <TopNavigation onBack={canGoBack ? onBack : undefined} onSkip={onComplete} />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
        <h1 className="mt-3 max-w-[390px] text-[38px] font-bold leading-[1.06] text-[#151b26]">
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
        <p className="mb-4 flex items-center justify-center gap-2 text-center text-[12px] leading-4 text-[#8b8f96]">
          <LockKeyhole className="h-4 w-4 shrink-0" />
          Your location is never sold. Sharing always requires your approval.
        </p>
        <PrimaryButton onClick={onComplete}>Continue</PrimaryButton>
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
}: OneLocationOnboardingFlowProps) {
  const [screen, setScreen] = useState<OnboardingScreen>(startAt);
  const [circleMembers, setCircleMembers] = useState<CircleMember[]>([]);
  const [failedRequestCount, setFailedRequestCount] = useState(0);
  const [requestsSending, setRequestsSending] = useState(false);
  const requestBatchRef = useRef(0);

  useEffect(() => {
    setScreen(startAt);
  }, [startAt]);

  // Warm the browser cache with every onboarding illustration as soon as the
  // flow mounts. Without this, each feature screen only fetches its art the
  // first time it renders, which shows a blank frame (pop-in) on slower
  // connections. Decoding ahead of time keeps screen transitions instant.
  useEffect(() => {
    if (typeof window === "undefined") return;
    for (const source of ONBOARDING_IMAGE_SOURCES) {
      const image = new window.Image();
      image.decoding = "async";
      image.src = source;
    }
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
      className="fixed inset-0 z-[540] flex h-dvh min-h-[100svh] w-full items-stretch justify-center overflow-hidden bg-[#eef3f8] text-[#171d28]"
      data-no-route-swipe
      data-testid="one-location-onboarding"
    >
      <NativeTestBeacon {...nativeTest} />
      <section className="flex h-full min-h-0 w-full max-w-[480px] flex-col overflow-hidden bg-white shadow-[0_0_40px_rgba(24,57,91,0.08)]">
        <div className="h-[env(safe-area-inset-top,0px)] shrink-0" />
        {screen === "welcome" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-[#087cf0] px-6 pb-[calc(env(safe-area-inset-bottom,0px)+20px)] text-white">
            <div className="flex min-h-full flex-1 flex-col">
              <div className="pt-6 text-center sm:pt-12">
                <p className="inline-flex items-center gap-2 text-[19px] font-bold">
                  <LocateFixed className="h-6 w-6" /> Onepoint
                </p>
                <h1 className="mx-auto mt-8 max-w-[390px] text-[38px] font-bold leading-[1.08]">
                  The people you love.<br />Always in reach.
                </h1>
                <p className="mx-auto mt-4 max-w-[370px] text-[18px] leading-7 text-white/82">
                  Private by default. Nothing is shared until you approve it.
                </p>
              </div>
              <div className="my-auto py-3 sm:py-5">
                <WelcomeRadar people={people} />
              </div>
              <PrimaryButton inverse onClick={() => setScreen("arrival")}>Get started</PrimaryButton>
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
          />
        ) : null}
      </section>
    </main>
  );
}
