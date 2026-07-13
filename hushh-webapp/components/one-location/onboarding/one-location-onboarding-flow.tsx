"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  BriefcaseBusiness,
  Check,
  ChevronLeft,
  Footprints,
  Loader2,
  LocateFixed,
  LockKeyhole,
  MapPin,
  PersonStanding,
  ShieldCheck,
  UserPlus,
} from "lucide-react";

import { NativeTestBeacon } from "@/components/app-ui/native-test-beacon";
import type { ConsentNotificationDeliveryMode } from "@/components/consent/notification-provider";
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
  onRequestNotifications: () => void;
  onComplete: () => void;
};

const FEATURE_SCREENS: OnboardingScreen[] = ["arrival", "checkin", "sos"];

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
            "inline-flex h-11 w-11 items-center justify-center rounded-full bg-white/90 shadow-[0_5px_18px_rgba(24,57,91,0.1)] transition-transform active:scale-95",
            light ? "text-white bg-white/15" : "text-[#087cf0]",
          )}
          aria-label="Go back"
        >
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
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
            light ? "text-white" : "text-[#087cf0]",
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
  const shown = people.slice(0, 3);
  const positions = [
    "left-[18%] top-[55%]",
    "right-[14%] top-[48%]",
    "right-[28%] top-[8%]",
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
      {(shown.length > 0
        ? shown
        : [
            { userId: "one-a", displayName: "Ava", photoUrl: null },
            { userId: "one-b", displayName: "Mia", photoUrl: null },
            { userId: "one-c", displayName: "Jay", photoUrl: null },
          ]
      ).map((person, index) => (
        <span key={person.userId} className={cn("absolute", positions[index])}>
          <Avatar name={safeName(person.displayName)} photoUrl={person.photoUrl} />
          <span className="absolute -right-0.5 -top-0.5 h-5 w-5 rounded-full border-[3px] border-white bg-[#34c759]" />
        </span>
      ))}
    </div>
  );
}

function FeatureAlert({
  person,
  text,
}: {
  person: DirectoryPerson | undefined;
  text: string;
}) {
  const name = safeName(person?.displayName, "Your person");
  return (
    <div className="absolute left-1/2 top-[10%] z-10 flex min-w-[190px] -translate-x-1/2 items-center gap-3 rounded-2xl border border-white bg-white px-3 py-2.5 shadow-[0_12px_30px_rgba(28,42,68,0.18)]">
      <Avatar name={name} photoUrl={person?.photoUrl} size="sm" />
      <div className="min-w-0 text-left">
        <p className="truncate text-[13px] font-bold text-[#182236]">{name}</p>
        <p className="truncate text-[12px] text-[#7d828b]">{text}</p>
      </div>
    </div>
  );
}

function ArrivalIllustration({ person }: { person?: DirectoryPerson }) {
  return (
    <div className="relative mx-auto h-[330px] w-full max-w-[390px] overflow-hidden rounded-[36px] bg-[#f4f3fb]" aria-hidden="true">
      <FeatureAlert person={person} text="arrived at Office" />
      <span className="absolute bottom-8 left-1/2 h-16 w-[75%] -translate-x-1/2 rounded-[50%] border border-white bg-white/55" />
      <div className="absolute left-1/2 top-[31%] flex h-44 w-40 -translate-x-1/2 items-center justify-center rounded-[32px] border-[5px] border-[#2f3047] bg-[#474961] shadow-[0_20px_35px_rgba(47,48,71,0.24)]">
        <BriefcaseBusiness className="h-24 w-24 text-[#282a3d]" strokeWidth={1.25} />
        <span className="absolute right-3 top-5 h-2.5 w-2.5 rounded-full bg-[#161724]" />
        <span className="absolute left-3 top-5 h-2.5 w-2.5 rounded-full bg-[#161724]" />
        <span className="absolute top-10 h-3 w-6 rounded-b-full bg-[#ff7d95]" />
        <MapPin className="absolute -right-5 top-20 h-12 w-12 fill-[#0a84ff] text-white drop-shadow-lg" />
      </div>
      <Footprints className="absolute bottom-6 left-1/2 h-20 w-20 -translate-x-1/2 text-[#313348]" />
    </div>
  );
}

function CheckinIllustration({ person }: { person?: DirectoryPerson }) {
  return (
    <div className="relative mx-auto h-[330px] w-full max-w-[390px] overflow-hidden rounded-[36px] bg-[#fbf7f2]" aria-hidden="true">
      <FeatureAlert person={person} text="checked in" />
      <span className="absolute bottom-10 left-1/2 h-14 w-[80%] -translate-x-1/2 rounded-[50%] border-b-4 border-dashed border-[#6cd2cf]" />
      <div className="absolute left-1/2 top-[31%] flex h-48 w-40 -translate-x-1/2 items-center justify-center rounded-[52%_52%_62%_62%] bg-[#1ec7bd] shadow-[0_20px_35px_rgba(30,199,189,0.25)]">
        <MapPin className="h-36 w-36 fill-[#1ec7bd] text-[#13aaa3]" strokeWidth={1.2} />
        <span className="absolute top-14 h-20 w-20 rounded-full bg-white">
          <span className="absolute left-5 top-7 h-2.5 w-2.5 rounded-full bg-[#172232]" />
          <span className="absolute right-5 top-7 h-2.5 w-2.5 rounded-full bg-[#172232]" />
          <span className="absolute bottom-5 left-1/2 h-3 w-7 -translate-x-1/2 rounded-b-full bg-[#ff7390]" />
        </span>
      </div>
      <PersonStanding className="absolute bottom-2 left-1/2 h-24 w-24 -translate-x-1/2 text-[#202b36]" />
    </div>
  );
}

function SosIllustration({ people }: { people: DirectoryPerson[] }) {
  return (
    <div className="relative mx-auto h-[330px] w-full max-w-[390px] overflow-hidden rounded-[36px] bg-[#fbf7f5]" aria-hidden="true">
      <span className="absolute left-[7%] top-[45%]">
        <Avatar name={safeName(people[0]?.displayName, "Ava")} photoUrl={people[0]?.photoUrl} size="lg" />
      </span>
      <span className="absolute right-[7%] top-[45%]">
        <Avatar name={safeName(people[1]?.displayName, "Mia")} photoUrl={people[1]?.photoUrl} size="lg" />
      </span>
      <span className="absolute left-[20%] top-[57%] w-[22%] border-t-2 border-dashed border-[#26334f]" />
      <span className="absolute right-[20%] top-[57%] w-[22%] border-t-2 border-dashed border-[#26334f]" />
      <div className="absolute left-1/2 top-[17%] flex h-48 w-44 -translate-x-1/2 items-center justify-center">
        <ShieldCheck className="h-44 w-44 fill-[#147ff0] text-[#0758c7] drop-shadow-[0_18px_22px_rgba(0,122,255,0.26)]" strokeWidth={1.8} />
        <span className="absolute top-20 h-4 w-4 rounded-full bg-white" />
        <span className="absolute left-[43%] top-20 h-4 w-4 rounded-full bg-white" />
        <span className="absolute top-[58%] h-4 w-9 rounded-b-full bg-[#ff8aa0]" />
      </div>
      <div className="absolute bottom-7 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full bg-white px-4 py-2 text-[12px] font-semibold text-[#4c5566] shadow-lg">
        <ShieldCheck className="h-4 w-4 text-[#ff708c]" /> Help sent
      </div>
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
  const content = {
    arrival: {
      title: "Know when they arrive",
      body: `"${safeName(people[0]?.displayName, "Someone")} arrived" - get a quiet alert the moment your people reach the places that matter.`,
      visual: <ArrivalIllustration person={people[0]} />,
      cta: "Continue",
    },
    checkin: {
      title: "Let them know you're here",
      body: `"${safeName(people[1]?.displayName, "Someone")} checked in" - one tap tells trusted people where you are. No call needed.`,
      visual: <CheckinIllustration person={people[1] ?? people[0]} />,
      cta: "Continue",
    },
    sos: {
      title: "Help when it matters most",
      body: `"Help sent" - SOS shares your live location with trusted contacts, instantly.`,
      visual: <SosIllustration people={people} />,
      cta: "Create my circle",
    },
  }[screen];

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-[#fffdfb]">
      <TopNavigation onBack={onBack} onSkip={onSkip} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 pb-3">
        <h1 className="mx-auto mb-4 max-w-[360px] text-center text-[31px] font-bold leading-[1.12] text-[#19243a]">
          {content.title}
        </h1>
        <div className="my-auto">{content.visual}</div>
        <p className="mx-auto mt-4 max-w-[375px] text-center text-[17px] font-semibold leading-[1.45] text-[#26334f]">
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
  onContinue: (selectedIds: string[]) => Promise<void>;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

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

  const continueToCircle = async () => {
    setSubmitting(true);
    try {
      await onContinue(selectedIds);
    } finally {
      setSubmitting(false);
    }
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
        <PrimaryButton onClick={() => void continueToCircle()} disabled={loading || submitting}>
          {submitting ? <Loader2 className="mr-2 h-5 w-5 animate-spin" /> : null}
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
  failedCount,
  onBack,
  onContinue,
}: {
  currentUserName: string;
  currentUserPhotoUrl?: string | null;
  members: CircleMember[];
  failedCount: number;
  onBack: () => void;
  onContinue: () => void;
}) {
  const pendingCount = members.filter((member) => member.status === "pending").length;
  const connectedCount = members.length - pendingCount;
  const title = pendingCount > 0
    ? "Your circle is taking shape"
    : connectedCount > 0
      ? "You're connected!"
      : "Your circle, your choice";
  const subtitle = pendingCount > 0
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
          {shown.length === 0 ? (
            <span className="absolute bottom-[8%] right-[9%] flex h-16 w-16 items-center justify-center rounded-full border-2 border-dashed border-[#83c4fb] bg-[#eaf5ff] text-[#087cf0]">
              <UserPlus className="h-7 w-7" />
            </span>
          ) : null}
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
  disabled,
  onClick,
}: {
  label: string;
  checked: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      onClick={onClick}
      disabled={disabled || busy}
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
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  checked: boolean;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
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
          disabled={disabled}
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
  onRequestNotifications: () => void;
  onComplete: () => void;
}) {
  const locationGranted =
    locationPermission?.state === "granted" &&
    locationPermission.locationServicesEnabled !== false;
  const notificationsGranted = notificationDeliveryMode === "push_active";
  const locationBlocked =
    locationPermission?.state === "denied" ||
    locationPermission?.state === "restricted" ||
    locationPermission?.locationServicesEnabled === false;

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
            description={
              locationBlocked
                ? "Open device Settings to allow location. It is shared only when you approve."
                : "Shows your place on the map and powers check-ins. Shared only when you approve."
            }
            checked={locationGranted}
            busy={locationBusy}
            disabled={locationGranted}
            onClick={() => void onRequestLocation()}
          />
          <PermissionRow
            icon={<Bell className="h-7 w-7" />}
            title="Notifications"
            description="Requests, check-ins, and SOS alerts from your people."
            checked={notificationsGranted}
            busy={notificationBusy}
            disabled={notificationsGranted}
            onClick={onRequestNotifications}
          />
          <PermissionRow
            icon={<PersonStanding className="h-7 w-7" />}
            title="Motion Activity"
            description="Not requested yet. One will ask only when a safety feature genuinely needs it."
            checked={false}
            disabled
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

  useEffect(() => {
    setScreen(startAt);
  }, [startAt]);

  const goBackFromFeature = () => {
    if (screen === "arrival") setScreen("welcome");
    if (screen === "checkin") setScreen("arrival");
    if (screen === "sos") setScreen("checkin");
  };

  const handlePeopleContinue = async (selectedIds: string[]) => {
    const selectedPeople = people.filter((person) => selectedIds.includes(person.userId));
    const requestIds = selectedPeople
      .filter((person) => person.relationship === "none")
      .map((person) => person.userId);
    const result = await onSendConnectionRequests(requestIds);
    const sentIds = new Set(result.sentUserIds);
    const activeIds = new Set(connections.map((connection) => connection.userId));
    const members: CircleMember[] = selectedPeople
      .filter(
        (person) =>
          person.relationship === "connected" ||
          activeIds.has(person.userId) ||
          sentIds.has(person.userId),
      )
      .map((person) => ({
        userId: person.userId,
        displayName: safeName(person.displayName),
        photoUrl: person.photoUrl,
        status:
          person.relationship === "connected" || activeIds.has(person.userId)
            ? "connected"
            : "pending",
      }));

    setCircleMembers(members);
    setFailedRequestCount(result.failedUserIds.length);
    setScreen("circle");
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
            onBack={() => setScreen("people")}
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
