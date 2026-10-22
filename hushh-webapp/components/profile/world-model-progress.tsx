"use client";

import { useState } from "react";
import { SettingsGroup, SettingsRow } from "@/components/profile/settings-ui";
import {
  ProfileInnerProgressIcon,
} from "@/components/profile/profile-inner-icons";
import { ProfilePaneGlobeIcon } from "@/components/profile/profile-pane-icons";
import {
  ProfileAccountMailIcon,
  ProfileAccountNameIcon,
  ProfileAccountPhoneIcon,
} from "@/components/profile/profile-your-account-icons";
import { Badge } from "@/components/ui/badge";
import { formatMaskedPhoneNumber } from "@/lib/services/phone-display";
import type { PwmProgress } from "@/lib/services/world-model-research-service";

/** Research covers this many topics; the server's topics_checked is bounded by it. */
export const PWM_TOPIC_COUNT = 20;
const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Past this with nothing received, the owner is told it is taking a while. */
export const STALL_MS = 90 * SECOND_MS;
/** Past this, the owner gets a Try again as well. */
export const LONG_STALL_MS = 5 * MINUTE_MS;

/** `m•••@example.com`: the pane never shows the owner's full address. */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "•••";
  return `${email[0]}•••${email.slice(at)}`;
}

export type PreparingStep = {
  /** The step itself; announced when it changes. */
  step: string;
  /** A ticking count shown beside the step, never announced. */
  detail: string | null;
};

/**
 * What research is doing, as one line for the status row. Never empty while
 * research runs: before the first progress arrives it says so. The step is
 * announced when it changes; the topic count beside it ticks quietly.
 */
export function preparingStepLine(
  progress: PwmProgress | null,
  resuming: boolean,
  live: boolean,
  /** Sources grew while the search count held: pages are being read. */
  reading = false,
): PreparingStep {
  if (!progress) {
    if (!live) return { step: "Reconnecting…", detail: null };
    // A turn is awaited before anything has started.
    return { step: resuming ? "Starting shortly…" : "Starting…", detail: null };
  }
  const prefix = resuming ? "Picking up again · " : "";
  switch (progress.stage) {
    case "starting":
      return { step: `${prefix}Step 1 of 3 · Getting ready`, detail: null };
    case "identity":
      return { step: `${prefix}Step 1 of 3 · Checking it’s you`, detail: null };
    case "coverage":
      return {
        step: `${prefix}Step 2 of 3 · ${reading ? "Reading sources" : "Searching public pages"}`,
        detail: `${progress.topics_checked.length} of ${PWM_TOPIC_COUNT} topics`,
      };
    case "report":
      return { step: `${prefix}Step 3 of 3 · Writing up what it found`, detail: null };
  }
}

/**
 * True from the moment a progress update adds sources without spending a
 * search, until the next search is spent: research is reading the pages it
 * found rather than looking for more.
 */
export function useReadingSources(progress: PwmProgress | null): boolean {
  const [seen, setSeen] = useState<{ progress: PwmProgress | null; reading: boolean }>({
    progress: null,
    reading: false,
  });
  if (progress === seen.progress) return seen.reading;
  // Derived from the previous update, settled during this render.
  let reading = seen.reading;
  if (!progress || !seen.progress || progress.stage !== "coverage") reading = false;
  else if (progress.searches_used > seen.progress.searches_used) reading = false;
  else if (progress.sources_found > seen.progress.sources_found) reading = true;
  setSeen({ progress, reading });
  return reading;
}

/** "just now" / "3m ago" / "2h ago", the Payouts freshness buckets. */
function ageLabel(age: number): string {
  if (age < MINUTE_MS) return "just now";
  if (age < HOUR_MS) return `${Math.min(59, Math.round(age / MINUTE_MS))}m ago`;
  if (age < DAY_MS) return `${Math.min(23, Math.round(age / HOUR_MS))}h ago`;
  return `${Math.round(age / DAY_MS)}d ago`;
}

/** "Updated just now" / "Updated 3m ago". */
export function updatedLabel(lastActivityAt: number, now: number): string {
  return `Updated ${ageLabel(Math.max(0, now - lastActivityAt))}`;
}

export type ActivityLine = {
  text: string;
  /** A move into this text is announced; the ticking ages are not. */
  notice: boolean;
};

/**
 * The group's one activity line while research runs. The owner always sees
 * that something is happening, and how long ago it last did.
 */
export function activityLine(input: {
  resuming: boolean;
  live: boolean;
  lastActivityAt: number | null;
  /** When this run began, from progress; adds "Started 4m ago" once it is a minute old. */
  startedAt?: string | null;
  /** A turn is awaited and nothing has started yet. */
  waiting?: boolean;
  now: number;
}): ActivityLine {
  const age =
    input.lastActivityAt === null ? null : Math.max(0, input.now - input.lastActivityAt);
  // A long quiet spell is said first, whatever the feed or the run claims:
  // a promised resume that never comes must not read as progress.
  if (age !== null && age >= LONG_STALL_MS)
    return {
      text: "Taking longer than usual. No new research update.",
      notice: true,
    };
  if (age !== null && age >= STALL_MS) {
    const minutes = Math.floor(age / MINUTE_MS);
    return {
      text: `Still working. Nothing new in the last ${minutes === 1 ? "minute" : `${minutes} minutes`}.`,
      notice: true,
    };
  }
  if (input.waiting) return { text: "Waiting for a turn. Starting shortly…", notice: false };
  if (input.resuming) return { text: "Paused. Picking up where it left off…", notice: false };
  if (!input.live) return { text: "Couldn’t get an update. Retrying…", notice: false };
  if (age === null) return { text: "Connecting…", notice: false };
  const started = input.startedAt ? Date.parse(input.startedAt) : Number.NaN;
  const since = Number.isFinite(started) ? input.now - started : 0;
  const prefix = since >= MINUTE_MS ? `Started ${ageLabel(since)} · ` : "";
  return { text: `${prefix}Last activity ${ageLabel(age)}`, notice: false };
}

/** The note under the card while research is still telling namesakes apart. */
export function identityNotice(progress: PwmProgress | null): string | null {
  switch (progress?.identity_state) {
    case "candidate_for_review":
    case "ambiguous":
      return "Possible match so far. You’ll confirm only what’s yours.";
    case "no_match":
      return "No clear match yet. Still looking.";
    default:
      return null;
  }
}

/** Research has no meaningful completion denominator; only observed counts are numeric. */
export function WorldModelProgressBar() {
  return (
    <div
      role="progressbar"
      aria-label="Research in progress"
      data-testid="pwm-progress-bar"
      className="h-0.5 w-full overflow-hidden rounded-full bg-[color:var(--app-neutral-fill)]"
    >
      <div
        data-testid="pwm-progress-fill"
        className="h-full w-1/3 animate-pulse rounded-full bg-[color:var(--app-accent)] motion-reduce:animate-none"
      />
    </div>
  );
}

/**
 * Observed counts and source titles from the latest progress update. A stopped
 * run shows the same checkpoint without a working bar or completion estimate.
 */
export function WorldModelProgressRows({
  progress,
  active = true,
}: {
  progress: PwmProgress | null;
  active?: boolean;
}) {
  const searched = progress
    ? `${progress.searches_used} of ${progress.searches_total} searches`
    : "Searching public pages";
  const counts = progress
    ? [
        `${progress.sources_found} ${progress.sources_found === 1 ? "source" : "sources"} found`,
        `${progress.topics_checked.length} ${progress.topics_checked.length === 1 ? "topic" : "topics"} checked`,
        // The first run is part 1; only a continued one says so.
        progress.slice > 1 ? `Continuing, part ${progress.slice}` : null,
      ]
        .filter((part): part is string => part !== null)
        .join(" · ")
    : "Counting what we find";
  const titles = progress?.recent_sources.slice(0, 3).map((source) => source.title) ?? [];
  return (
    <>
      <SettingsRow
        testId="pwm-progress-row"
        icon={ProfileInnerProgressIcon}
        iconTone="capability"
        title={active ? searched : `Last research checkpoint · ${searched}`}
        description={
          <span className="block space-y-1.5">
            <span className="block tabular-nums">{counts}</span>
            {active ? <WorldModelProgressBar /> : null}
          </span>
        }
      />
      {progress && titles.length > 0 ? (
        <SettingsRow
          testId="pwm-sources-row"
          icon={ProfilePaneGlobeIcon}
          iconTone="capability"
          title={active ? "Sources so far" : "Sources in last checkpoint"}
          description={
            <span className="line-clamp-2 [overflow-wrap:anywhere]">
              {titles.join(" · ")}
            </span>
          }
          trailing={String(progress.sources_found)}
        />
      ) : null}
    </>
  );
}

/** "Using your name, email and phone": the verified details research pivots on. */
export function identityTitle(input: {
  name: boolean;
  email: boolean;
  phone: boolean;
}): string {
  const parts = [
    input.name ? "your name" : null,
    input.email ? "email" : null,
    input.phone ? "phone" : null,
  ].filter((part): part is string => part !== null);
  if (parts.length === 0) return "Looking for";
  if (!input.name) parts[0] = `your ${parts[0]}`;
  const last = parts.pop()!;
  return `Using ${parts.length > 0 ? `${parts.join(", ")} and ${last}` : last}`;
}

export type WorldModelIdentityInput = {
  name: string | null | undefined;
  email: string | null | undefined;
  emailVerified: boolean;
  phone: string | null | undefined;
};

/** The identity group's title for an account, as its landmark is named too. */
export function identityGroupTitle(input: WorldModelIdentityInput): string {
  return identityTitle({
    name: Boolean(input.name),
    email: Boolean(input.email) && input.emailVerified,
    phone: Boolean(input.phone && formatMaskedPhoneNumber(input.phone)),
  });
}

/**
 * What research looks for: the account's name and verified contacts, shown
 * the way the Account pane shows them (contacts masked), so the owner can see
 * what tells them apart from people with the same name.
 */
export function WorldModelIdentityGroup({
  name,
  email,
  emailVerified,
  phone,
}: WorldModelIdentityInput) {
  const masked = phone ? formatMaskedPhoneNumber(phone) : "";
  const title = identityGroupTitle({ name, email, emailVerified, phone });
  return (
    <SettingsGroup title={title} density="compact">
      <SettingsRow
        testId="pwm-identity-name"
        icon={ProfileAccountNameIcon}
        iconTone="capability"
        title="Name"
        description={name || "Not added"}
      />
      <SettingsRow
        testId="pwm-identity-email"
        icon={ProfileAccountMailIcon}
        iconTone="capability"
        title="Email"
        description={email ? maskEmail(email) : "Not added"}
        trailing={
          email ? (
            <Badge variant="secondary">{emailVerified ? "Verified" : "Not verified"}</Badge>
          ) : undefined
        }
      />
      <SettingsRow
        testId="pwm-identity-phone"
        icon={ProfileAccountPhoneIcon}
        iconTone="capability"
        title="Phone"
        description={masked || "Not added"}
        trailing={masked ? <Badge variant="secondary">Verified</Badge> : undefined}
      />
    </SettingsGroup>
  );
}
