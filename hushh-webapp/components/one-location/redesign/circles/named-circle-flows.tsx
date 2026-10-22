"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { trackEvent } from "@/lib/observability/client";
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  LogOut,
  Plus,
  Search,
  Share2,
  Trash2,
  UsersRound,
} from "@/components/icons";
import { AddPeopleAction } from "@/components/app-ui/add-people-action";

import { Button, buttonVariants } from "@/components/ui/button";
import { INPUT_CLASSNAME } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  SheetClose,
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AdaptiveSheetContent, TaskSurfaceBody, TaskSurfaceToolbar, TaskSurfaceFooter, TaskAlertDialogContent, useTaskSurfacePresentation, taskSurfaceStyles } from "@/lib/morphy-ux/ui/task-surfaces";
import { SheetCount, SheetSearch } from "@/components/app-ui/sheet-parts";
import { SettingsGroup, SettingsRow } from "@/components/app-ui/settings-ui";
import { SmsTextIcon } from "@/components/one-location/redesign/sms-text-icon";
import { SectionLabel, TrailingValue } from "@/components/app-ui/typography";
import {
  EmptyState,
  TaskFlowHeader,
} from "@/components/one-location/redesign/primitives";
import {
  CARD_SURFACE,
  MUTED_TEXT,
} from "@/components/one-location/redesign/tokens";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { buildConsentCenterHref } from "@/lib/consent/consent-sheet-route";
import { connectPersonName } from "@/lib/connections/person-label";
import { MAX_CUSTOM_CIRCLE_TYPES, MAX_CIRCLE_TYPE_LABEL_LENGTH, normalizeCircleTypeLabel } from "@/lib/one-location/circle-types";
import {
  buildDirectMessageRoute,
  buildPersonProfileRoute,
  ROUTES,
} from "@/lib/navigation/routes";
import {
  CIRCLE_RENAME_NAME_INPUT_CLASSNAME,
  CIRCLE_NAME_ROW_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-name-row-layout";
import {
  CIRCLE_DETAIL_HEADER_CLASSNAME,
  CIRCLE_DETAIL_HEADER_COPY_CLASSNAME,
  CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME,
  CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME,
  CIRCLE_LEAVE_ACTION_CLASSNAME,
  CIRCLE_PROCEED_TO_SMS_CLASSNAME,
  CIRCLE_MEMBER_ACTION_CLASSNAME,
  CIRCLE_MEMBER_ACTION_COPY_CLASSNAME,
  CIRCLE_MEMBER_STACKED_ACTION_CLASSNAME,
  CIRCLE_MEMBER_AVATAR_CLASSNAME,
  CIRCLE_MEMBER_NAME_CLASSNAME,
  CIRCLE_MEMBER_NAME_ROW_CLASSNAME,
  CIRCLE_MEMBER_ROW_CLASSNAME,
  CIRCLE_MEMBER_SECONDARY_CLASSNAME,
  CIRCLE_MEMBER_TRAILING_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-member-row-layout";
import { CircleMemberActionsMenu } from "@/components/one-location/redesign/circles/circle-member-actions-menu";
import {
  CIRCLE_SHEET_CTA_CLASSNAME,
  CIRCLE_SHEET_FIRST_GROUP_HEADING_CLASSNAME,
  CIRCLE_SHEET_NEXT_GROUP_HEADING_CLASSNAME,
} from "@/components/one-location/redesign/circles/circle-sheet-layout";
import type {
  OneLocationCircleDetail,
  OneLocationCircleEligibleConnection,
  OneLocationCircleEligibleConnections,
  OneLocationCircleEligibleConnectionsPage,
  OneLocationCircleInviteCode,
  OneLocationCircleInvitePreview,
  OneLocationCircleKind,
  OneLocationCircleMember,
  OneLocationCircleMemberInvite,
  OneLocationCircleMemberPage,
  OneLocationCircleOverview,
  OneLocationCircleSummary,
} from "@/lib/one-location/types";
import {
  filterPeopleByQuery,
  sortPeopleByName,
} from "@/lib/one-location/people-search";
import { sortCircleMembersOwnerFirst } from "@/lib/one-location/circle-member-order";
import {
  isForeignSmsSystemCircle,
  isSmsSystemCircle,
} from "@/lib/one-location/system-circles";
import { BLOCKED_CTA } from "@/components/one-location/redesign/circles/blocked-cta";
import { LOCATION_ACTION_SHAPE } from "../location-action-styles";
import { CirclePersonSelectionRow } from "./circle-person-selection-row";
import { ConnectionPersonAvatar } from "@/components/connections/connection-person-avatar";
import connectStyles from "@/components/connect/connect-workspace.module.css";
import { LivingCirclePanel } from "@/components/connect/circles/living-circle-panel";
import { CirclePhotoEditor } from "@/components/connect/circles/circle-photo-editor";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { relationshipCta } from "@/lib/connections/relationship-label";
import { ActionMenu } from "@/components/app-ui/action-menu";
import { FlowActionGroup } from "@/components/app-ui/flow-actions";
import { cn } from "@/lib/utils";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { CreateCirclePeopleBody, useCreateCirclePeopleModel, type CirclePeoplePageLoader } from "./create-circle-people-step";
import {
  CIRCLE_INVITE_BATCH_LIMIT,
  circleInviteSelectionLimit,
} from "@/lib/one-location/circle-invite-contract";

const CIRCLES_GROUP_SURFACE =
  "[--settings-group-radius:17px] !rounded-[17px] !bg-[color:var(--app-primary-surface)] !shadow-none";

const CIRCLES_EMPTY_STATE_WRAPPER =
  "[&>[data-ui-role=grouped-card]]:rounded-[var(--app-radius-md)] [&>[data-ui-role=grouped-card]]:!bg-[color:var(--app-primary-surface)] [&>[data-ui-role=grouped-card]]:shadow-[var(--app-card-shadow-standard)] dark:[&>[data-ui-role=grouped-card]]:shadow-none";

/**
 * Leave / Delete circle.
 *
 * `variant="outline"` gave these a filled neutral slab with a red hairline and
 * red label -- a painted button that reads as the loudest control on a screen
 * whose actual primary action is "Add people". iOS puts a destructive row on
 * the same card surface as everything else and lets the red label carry it,
 * which is what this does.
 */
const CIRCLE_DESTRUCTIVE_ACTION =
  "ui-text-button-label h-11 min-h-11 w-full rounded-full text-destructive hover:bg-destructive/10 hover:text-destructive";

/**
 * A circle is a group of trusted people, so its glyph carries the PEOPLE role
 * rather than the accent used for things you can DO. The action controls that
 * sit alongside it (New circle, Join, Share, Add people) stay accent, which is
 * what keeps "this is a group" and "this is a button" from looking alike.
 *
 * Glyph only. The wells this sits in ask for `--app-accent-soft`, a token that
 * is defined nowhere, so they have always rendered unpainted — giving them a
 * tint would add painted area rather than recolour it, so the recolour stops
 * at the icon.
 *
 * Used on the two surfaces where the viewer is NOT yet a member (an incoming
 * invite, a join preview), so the "nobody but you in here" neutral state the
 * circle LIST applies cannot arise and there is nothing to resolve.
 */
const CIRCLE_PEOPLE_GLYPH = roleClasses("people").glyph;

function circleInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

/**
 * Subtitle for the "Your circles" list row, e.g. "3 people".
 *
 * Counts everyone in the Circle, owner included — matching the Circle Detail
 * subtitle, which does the same. The backend `memberCount` already includes
 * the owner (they always hold a membership row), so this is the raw count.
 *
 * The kind used to lead this line — "Family · 0 members". Reported from QA:
 * the circle created during onboarding is filed under Family by default and
 * the person was never asked, so the row opened by telling them a category
 * they had not picked, ahead of the only number on the line that was true.
 * There are three kinds and nothing on this screen acts on any of them, so
 * the word was decoration in front of the fact. The count stands alone.
 */
function circleListPeopleLabel(memberCount: number | null | undefined): string {
  const count = Math.max(0, Number(memberCount || 0));
  if (count <= 1) return "Only you";
  return `${count} people`;
}

type CircleListGroupKey = "owned" | "joined";

type CircleListGroup = {
  key: CircleListGroupKey;
  title: string;
  circles: OneLocationCircleSummary[];
};

function circleListGroupKey(
  circle: OneLocationCircleSummary,
): CircleListGroupKey {
  return circle.role === "owner" ? "owned" : "joined";
}

function groupCirclesForPeopleTab(
  circles: readonly OneLocationCircleSummary[],
): CircleListGroup[] {
  const groups: CircleListGroup[] = [
    { key: "owned", title: "Your circles", circles: [] },
    { key: "joined", title: "Joined circles", circles: [] },
  ];
  const groupByKey = new Map(groups.map((group) => [group.key, group]));

  for (const circle of circles) {
    // Someone else's SMS Circle is not usable on the viewer's side (it can
    // neither authorize shares nor be managed), so the People tab hides it.
    // The viewer's own SMS Circle stays under "Your circles".
    if (isForeignSmsSystemCircle(circle)) continue;
    groupByKey.get(circleListGroupKey(circle))?.circles.push(circle);
  }

  return groups.filter((group) => group.circles.length > 0);
}

function circleDetailMemberCountLabel(count: number): string {
  if (count <= 1) return "Only you";
  return `${count} people`;
}

function smsCircleCapacityDescription(
  remainingCapacity: number,
  loading: boolean,
  error: string | null,
): string {
  if (loading) return "Checking available places…";
  if (error) return "Couldn’t check available places.";
  if (remainingCapacity === 0) return "Your SMS Circle is full.";
  return `You can add ${remainingCapacity} more ${remainingCapacity === 1 ? "person" : "people"}.`;
}

function CircleSummaryRow({
  circle,
  onOpen,
}: {
  circle: OneLocationCircleSummary;
  onOpen: (circleId: string) => void;
}) {
  const isSmsCircle = circle.systemKind === "sms";
  const initials = circleInitials(circle.name);
  const showInitials =
    !isSmsCircle && circle.systemKind !== "trusted" && initials;

  return (
    <SettingsRow
      leading={
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center",
            isSmsCircle
              ? "rounded-full bg-[color:var(--app-destructive)] text-[color:var(--app-destructive-fg)]"
              : "rounded-[10px] bg-[#E5E5EA] text-[13px] font-semibold text-[#6E6E73] dark:bg-[rgba(142,142,147,0.28)] dark:text-[#F2F2F7]",
          )}
          data-testid={
            isSmsCircle
              ? "one-location-circle-sms-mark"
              : "one-location-circle-neutral-mark"
          }
        >
          {isSmsCircle ? (
            <SmsTextIcon className="text-[11px] font-bold tracking-[-0.2px]" />
          ) : showInitials ? (
            initials
          ) : (
            <UsersRound className="h-[17px] w-[17px]" />
          )}
        </span>
      }
      title={circle.name}
      description={
        isSmsCircle
          ? `Save My Soul · ${circleListPeopleLabel(circle.memberCount)}`
          : circleListPeopleLabel(circle.memberCount)
      }
      chevron
      onClick={() => onOpen(circle.id)}
      className={cn(
        "[--settings-row-gap:12px] [--settings-row-px:16px] [--settings-row-py:10px]",
        "[&>button]:min-h-[60px] sm:[&>button]:min-h-16",
        "[&_[data-slot=settings-row-title]]:!text-[17px] [&_[data-slot=settings-row-title]]:!font-medium [&_[data-slot=settings-row-title]]:!leading-[22px] [&_[data-slot=settings-row-title]]:!tracking-[-0.3px]",
        "[&_[data-slot=settings-row-description]]:!mt-0.5 [&_[data-slot=settings-row-description]]:!text-[13px] [&_[data-slot=settings-row-description]]:!font-normal [&_[data-slot=settings-row-description]]:!leading-[18px] [&_[data-slot=settings-row-description]]:!tracking-[-0.2px]",
      )}
      testId={`one-location-circle-${circle.id}`}
    />
  );
}

function circleFlowErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : fallback;
}

export function CirclesSection({
  circles,
  incomingInvites,
  incomingInvitesLoading,
  incomingInvitesError,
  focusedInviteId,
  focusedInviteResolutionReady,
  inviteBusy,
  onCreate,
  onJoin,
  onOpen,
  onAcceptInvite,
  onDeclineInvite,
  onRetryInvites,
  onDismissFocusedInvite,
}: {
  circles: OneLocationCircleSummary[];
  incomingInvites: OneLocationCircleMemberInvite[];
  incomingInvitesLoading: boolean;
  incomingInvitesError: string | null;
  focusedInviteId: string | null;
  focusedInviteResolutionReady: boolean;
  inviteBusy: boolean;
  onCreate: () => void;
  onJoin: () => void;
  onOpen: (circleId: string) => void;
  onAcceptInvite: (inviteId: string) => Promise<void>;
  onDeclineInvite: (inviteId: string) => Promise<void>;
  onRetryInvites: () => void;
  onDismissFocusedInvite: () => void;
}) {
  const [respondingInviteId, setRespondingInviteId] = useState<string | null>(
    null,
  );
  const responseInFlightRef = useRef(false);
  const focusedInviteElementRef = useRef<HTMLDivElement | null>(null);
  const focusedInvite = focusedInviteId
    ? (incomingInvites.find((invite) => invite.id === focusedInviteId) ?? null)
    : null;

  const circleGroups = useMemo(
    () => groupCirclesForPeopleTab(circles),
    [circles],
  );

  useEffect(() => {
    if (
      !focusedInvite ||
      incomingInvitesLoading ||
      !focusedInviteElementRef.current
    ) {
      return;
    }
    const element = focusedInviteElementRef.current;
    element.focus({ preventScroll: true });
    if (typeof element.scrollIntoView === "function") {
      element.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [focusedInvite, incomingInvitesError, incomingInvitesLoading]);

  const respondToInvite = async (
    invite: OneLocationCircleMemberInvite,
    decision: "accept" | "decline",
  ) => {
    if (responseInFlightRef.current || inviteBusy) return;
    responseInFlightRef.current = true;
    setRespondingInviteId(invite.id);
    try {
      if (decision === "accept") {
        await onAcceptInvite(invite.id);
      } else {
        await onDeclineInvite(invite.id);
      }
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(
          error,
          decision === "accept"
            ? "Could not join this Circle."
            : "Could not decline this invitation.",
        ),
      );
    } finally {
      responseInFlightRef.current = false;
      setRespondingInviteId(null);
    }
  };

  return (
    <div className="space-y-3" data-profile-type-scale="circles" data-testid="one-location-named-circles">
      <div className="flex w-full items-center justify-between gap-4">
        <h2 data-profile-role="group-label" className="text-[15px] font-medium leading-5 tracking-[-0.01em] text-[color:var(--app-section-label)]">
          Circles
        </h2>

        <div
          className={cn(
            "relative flex-none overflow-visible",
            "[&_[data-radix-popper-content-wrapper]]:!absolute",
            "[&_[data-radix-popper-content-wrapper]]:!bottom-auto",
            "[&_[data-radix-popper-content-wrapper]]:!left-auto",
            "[&_[data-radix-popper-content-wrapper]]:!right-0",
            "[&_[data-radix-popper-content-wrapper]]:!top-full",
            "[&_[data-radix-popper-content-wrapper]]:!z-[212]",
            "[&_[data-radix-popper-content-wrapper]]:!mt-2",
            "[&_[data-radix-popper-content-wrapper]]:!transform-none",
          )}
        >
          <ActionMenu
            profileTypeScale="circles"
            label="Add Circle"
            title="Circles"
            triggerIcon={Plus}
            testId="one-location-add-circle"
            items={[
              {
                id: "create",
                label: "Create Circle",
                icon: Plus,
                onSelect: onCreate,
                voiceControlId: "one-location-action-create-circle",
              },
              {
                id: "join",
                label: "Join with code",
                icon: KeyRound,
                onSelect: onJoin,
                voiceControlId: "one-location-action-join-circle",
              },
            ]}
          />
        </div>
      </div>

      {incomingInvitesError ? (
        <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
          <EmptyState
            title="Circle invitations unavailable"
            description={incomingInvitesError}
            action={
              <Button
                type="button"
                variant="outline"
                size="standard"
                disabled={incomingInvitesLoading}
                isLoading={incomingInvitesLoading}
                onClick={onRetryInvites}
              >
                Retry
              </Button>
            }
          />
        </div>
      ) : null}

      {incomingInvitesLoading &&
      !incomingInvites.length &&
      !incomingInvitesError ? (
        <div
          role="status"
          className="flex min-h-16 items-center justify-center gap-2 rounded-[var(--app-radius-md)] bg-[color:var(--app-primary-surface)] text-sm text-[color:var(--app-secondary-label)] shadow-[var(--app-card-shadow-standard)] dark:shadow-none"
        >
          <Loader2 className="h-5 w-5 animate-spin" />
          Checking Circle invitations…
        </div>
      ) : null}

      {incomingInvites.length ? (
        <SettingsGroup
          title="Circle invitations"
          shellClassName={CIRCLES_GROUP_SURFACE}
          testId="one-location-circle-member-invites"
        >
          {incomingInvites.map((invite) => {
            const responding = respondingInviteId === invite.id;
            const isFocused = invite.id === focusedInviteId;
            return (
              <div
                key={invite.id}
                ref={isFocused ? focusedInviteElementRef : undefined}
                tabIndex={isFocused ? -1 : undefined}
                className={cn(
                  "flex min-h-[64px] flex-col gap-3 px-4 py-3 outline-none sm:flex-row sm:items-center",
                  isFocused &&
                    "bg-[color:var(--app-accent-soft)] ring-2 ring-inset ring-[color:var(--app-accent-ring)]",
                )}
                data-focused={isFocused || undefined}
                data-testid={`one-location-circle-invite-${invite.id}`}
              >
                <span
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[color:var(--app-accent-soft)]",
                    CIRCLE_PEOPLE_GLYPH,
                  )}
                >
                  <UsersRound className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p data-profile-role="name" className="whitespace-normal text-[15px] font-semibold text-foreground [overflow-wrap:anywhere]">
                    {invite.circleName}
                  </p>
                  <p data-profile-role="description" className={MUTED_TEXT}>
                    Invited by {connectPersonName({ displayName: invite.inviterDisplayName })}
                  </p>
                </div>
                <FlowActionGroup
                  className="sm:w-auto"
                  secondary={
                    <Button
                      type="button"
                      variant="outline"
                      size="standard"
                      disabled={inviteBusy || Boolean(respondingInviteId)}
                      onClick={() => void respondToInvite(invite, "decline")}
                    >
                      Decline
                    </Button>
                  }
                  primary={
                    <Button
                      type="button"
                      size="standard"
                      disabled={inviteBusy || Boolean(respondingInviteId)}
                      isLoading={responding}
                      onClick={() => void respondToInvite(invite, "accept")}
                    >
                      Join
                    </Button>
                  }
                />
              </div>
            );
          })}
        </SettingsGroup>
      ) : null}

      {focusedInviteId &&
      focusedInviteResolutionReady &&
      !focusedInvite &&
      !incomingInvitesLoading &&
      !incomingInvitesError ? (
        <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
          <EmptyState
            title="Circle invitation no longer available"
            description="It may have expired, been cancelled or already been answered."
            action={
              <Button
                type="button"
                variant="outline"
                size="standard"
                onClick={onDismissFocusedInvite}
              >
                Dismiss
              </Button>
            }
          />
        </div>
      ) : null}

      {circleGroups.length ? (
        <div className="space-y-4" data-testid="one-location-circle-list">
          {circleGroups.map((group) => (
            <section
              key={group.key}
              className="space-y-2"
              data-testid={`one-location-circle-group-${group.key}`}
            >
              <SectionLabel
                as="h3"
                compact
                className="px-[6px] text-[13px] font-normal leading-[18px] text-[color:var(--app-secondary-label)]"
              >
                {group.title}
              </SectionLabel>
              <SettingsGroup
                separatorInset
                shellClassName={CIRCLES_GROUP_SURFACE}
                testId={`one-location-circle-group-list-${group.key}`}
              >
                {group.circles.map((circle) => (
                  <CircleSummaryRow
                    key={circle.id}
                    circle={circle}
                    onOpen={onOpen}
                  />
                ))}
              </SettingsGroup>
            </section>
          ))}
        </div>
      ) : (
        <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
          <EmptyState
            title="No circles yet"
            description="Create one for family or friends, or join with a code."
          />
        </div>
      )}
    </div>
  );
}

const CIRCLE_KIND_OPTIONS: {
  value: OneLocationCircleKind;
  label: string;
}[] = [
  { value: "family", label: "Family" },
  { value: "friends", label: "Friends" },
  { value: "other", label: "Other" },
];

export type CreateCircleFlowProps = {
  active?: boolean;
  busy: boolean;
  onSubmit: (name: string, kind: OneLocationCircleKind, existingCircleId?: string, customTypeLabel?: string) => Promise<OneLocationCircleDetail>;
  customTypes?: readonly string[];
  customTypesSupported?: boolean;
  /** Location hides the choice and retains the existing family default. */
  showCircleType?: boolean;
  onLoadPeople: CirclePeoplePageLoader;
  onAddPeople: (circleId: string, userIds: string[]) => Promise<unknown>;
  onComplete: (circleId: string) => void;
  pathname?: string;
  backLayerQuery?: Readonly<Record<string, string>>;
};

/** One create/update writer and one people draft, shared by both renderers. */
export function useCreateCircleFlow({
  active = true,
  busy,
  onSubmit,
  showCircleType = true,
  customTypes = [],
  customTypesSupported = false,
  onLoadPeople,
  onAddPeople,
  onComplete,
  pathname = ROUTES.ONE_LOCATION,
  backLayerQuery = { action: "create-circle" },
}: CreateCircleFlowProps) {
  const [name, setName] = useState("");
  const [nameRequirementActive, setNameRequirementActive] = useState(false);
  const [nameFocused, setNameFocused] = useState(false);
  const [kind, setKind] = useState<OneLocationCircleKind>("family");
  const [customTypeLabel, setCustomTypeLabel] = useState("");
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const [step, setStep] = useState<"details" | "people">("details");
  const [savedCircle, setSavedCircle] = useState<OneLocationCircleDetail | null>(null);
  const [saving, setSaving] = useState(false);
  const [addingPeople, setAddingPeople] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef({ name: "", kind: "family" as OneLocationCircleKind, customTypeLabel: "", revision: 0 });
  const inputRevision = useCallback(() => input.current.revision, []);
  const changeDraft = useCallback((draft: { name: string; kind: OneLocationCircleKind; customTypeLabel?: string }, expectedRevision?: number) => {
    if (!mounted.current || submittingRef.current || expectedRevision !== undefined && input.current.revision !== expectedRevision ||
      draft.name.length > 80 || !["family", "friends", "other"].includes(draft.kind)) return false;
    const nextType = draft.kind === "other" ? (draft.customTypeLabel ?? input.current.customTypeLabel) : "";
    if (nextType.length > MAX_CIRCLE_TYPE_LABEL_LENGTH) return false;
    if (input.current.name === draft.name && input.current.kind === draft.kind && input.current.customTypeLabel === nextType) return true;
    input.current = { ...draft, customTypeLabel: nextType, revision: input.current.revision + 1 };
    setName(draft.name); setKind(draft.kind); setCustomTypeLabel(nextType); if (draft.name.trim()) setNameRequirementActive(false);
    return true;
  }, []);
  // One typed character is a name. Requiring two silently withheld the button
  // from anyone naming a circle "A", with nothing on screen saying why.
  const trimmedName = name.trim();
  const nameMissing = trimmedName.length < 1;
  const normalizedType = normalizeCircleTypeLabel(customTypeLabel);
  const existingType = customTypes.find(label => label.toLocaleLowerCase() === normalizedType.toLocaleLowerCase());
  const typeError = kind === "other" && normalizedType && customTypesSupported
    ? normalizedType.length > MAX_CIRCLE_TYPE_LABEL_LENGTH
      ? "Use up to 32 characters for the type name."
      : ["family", "friends", "other"].includes(normalizedType.toLocaleLowerCase())
      ? "Choose Family or Friends above, or use another type name."
      : !savedCircle && !existingType && customTypes.length >= MAX_CUSTOM_CIRCLE_TYPES
        ? "You can keep up to 3 custom types. Delete a type before adding another."
        : null
    : null;
  const canSubmit = !nameMissing && !typeError && !busy && !saving;
  const nameHelpId = "one-location-create-circle-name-help";
  const showNameError = nameRequirementActive && nameMissing;
  const showNameCount = nameFocused && !showNameError && name.length >= 64;
  const nameHelpText = showNameError
    ? "Enter a Circle name."
    : showNameCount
      ? `${name.length} / 80`
      : "";

  // Hold across the caller's busy reset to prevent duplicate creates. Returning
  // to details releases the guard, while savedCircle keeps the existing ID.
  const submittingRef = useRef(false);
  const backToDetails = () => {
    if (busy || saving || addingPeople) return;
    submittingRef.current = false;
    setStep("details");
    window.requestAnimationFrame(() => nameInputRef.current?.focus());
  };
  useBackLayer(pathname, active && step === "people" ? 2 : 0, () => {
    backToDetails();
    return true;
  }, backLayerQuery);

  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const current = useCallback(() => mounted.current, []);
  const stepRef = useRef(step), addingRef = useRef(addingPeople);
  const mutationPending = useCallback(() => (submittingRef.current && stepRef.current === "details") || addingRef.current, []);
  stepRef.current = step; addingRef.current = addingPeople;
  useEffect(() => {
    if (active) return;
    input.current = { name: "", kind: "family", customTypeLabel: "", revision: input.current.revision + 1 };
    submittingRef.current = false; setName(""); setKind("family"); setCustomTypeLabel(""); setNameRequirementActive(false); setNameFocused(false);
    setStep("details"); setSavedCircle(null); setSaving(false); setAddingPeople(false);
    setError(null);
  }, [active]);
  const prepare = async (draft = input.current) => {
    if (!mounted.current || submittingRef.current || busy || saving) return false;
    const nextName = draft.name.trim();
    const enteredType = draft.kind === "other" && customTypesSupported ? normalizeCircleTypeLabel(draft.customTypeLabel) : "";
    const nextType = customTypes.find(label => label.toLocaleLowerCase() === enteredType.toLocaleLowerCase()) ?? enteredType;
    if (typeError) return false;
    if (nextName.length < 1 || draft.name.length > 80) {
      setNameRequirementActive(true);
      window.requestAnimationFrame(() => nameInputRef.current?.focus());
      return false;
    }
    submittingRef.current = true;
    setSaving(true); setError(null);
    try {
      const circle = savedCircle && savedCircle.name === nextName && savedCircle.kind === draft.kind && (savedCircle.customTypeLabel ?? "") === nextType
        ? savedCircle
        : await (nextType ? onSubmit(nextName, draft.kind, savedCircle?.id, nextType) : onSubmit(nextName, draft.kind, savedCircle?.id));
      if (!mounted.current) return false;
      setSavedCircle(circle);
      if (nextType && circle.customTypeLabel !== nextType) {
        throw new Error("Could not save the Circle type. Please try again.");
      }
      try {
        if (!savedCircle) trackEvent("one_location_circle_created", {
          route_id: "one_location",
          result: "success",
          circle_kind: draft.kind,
        });
      } catch {}
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      submittingRef.current = false;
      const message = circleFlowErrorMessage(error, "Could not create this Circle.");
      setError(message); toast.error(message);
      return false;
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const advance = () => { if (mounted.current && submittingRef.current) setStep("people"); };
  const submit = async () => { if (await prepare()) advance(); };
  const peopleProps = { circleId: savedCircle?.id ?? "", circleName: savedCircle?.name ?? "", active: active && step === "people", onLoad: onLoadPeople,
    onAdd: onAddPeople, onComplete, onBack: backToDetails, onSavingChange: setAddingPeople };
  const people = useCreateCirclePeopleModel(peopleProps);
  return { name, setName: (name: string) => changeDraft({ ...input.current, name }), nameRequirementActive, setNameRequirementActive, nameFocused, setNameFocused,
    kind, setKind: (kind: OneLocationCircleKind) => changeDraft({ ...input.current, kind }), inputRevision, changeDraft,
    customTypeLabel, setCustomTypeLabel: (label: string) => changeDraft({ ...input.current, customTypeLabel: label }), customTypes, customTypesSupported, typeError,
    nameInputRef, step, savedCircle, saving, addingPeople, nameMissing, canSubmit, nameHelpId, showNameError, nameHelpText,
    backToDetails, submit, prepare, advance, people, peopleProps, current, mutationPending, busy, showCircleType, error };
}

export type CreateCircleFlowModel = ReturnType<typeof useCreateCircleFlow>;
export function CreateCircleFlow(props: CreateCircleFlowProps) {
  return <CreateCircleFlowBody model={useCreateCircleFlow(props)} />;
}
export function CreateCircleFlowBody({ model }: { model: CreateCircleFlowModel }) {
  const { name, setName, setNameRequirementActive, setNameFocused, kind, nameInputRef, step, savedCircle,
    saving, nameMissing, canSubmit, nameHelpId, showNameError, nameHelpText, submit, people, peopleProps, busy, showCircleType } = model;
  const kindOptions = [...CIRCLE_KIND_OPTIONS.slice(0, 2),
    ...(model.customTypesSupported ? model.customTypes.slice(0, MAX_CUSTOM_CIRCLE_TYPES).map((label, index) => ({ value: `custom-${index}`, label })) : []),
    ...CIRCLE_KIND_OPTIONS.slice(2)];
  const selectedKind = kind !== "other" ? kind : kindOptions.find(option => option.value.startsWith("custom-") && option.label.toLocaleLowerCase() === normalizeCircleTypeLabel(model.customTypeLabel).toLocaleLowerCase())?.value ?? "other";
  const chooseKind = (option: { value: string; label: string }) => {
    if (option.value.startsWith("custom-")) {
      model.changeDraft({ name, kind: "other", customTypeLabel: option.label });
    } else {
      model.changeDraft({ name, kind: option.value as OneLocationCircleKind, customTypeLabel: "" });
    }
  };

  const inTaskSurface = useTaskSurfacePresentation();
  const Body = inTaskSurface ? TaskSurfaceBody : "div";
  const Footer = inTaskSurface ? TaskSurfaceFooter : "div";

  return (
    <div data-profile-type-scale={!inTaskSurface && step === "people" ? "circles" : undefined} data-testid="one-location-create-circle-flow" data-circle-create-step={step} className={inTaskSurface && step === "details" ? "contents" : step === "people" ? "flex min-h-0 flex-1 flex-col" : undefined}>
      {savedCircle ? <div hidden={step !== "people"} className={step === "people" ? "flex min-h-0 flex-1 flex-col" : undefined}>
        <CreateCirclePeopleBody {...peopleProps} model={people} />
      </div> : null}
      <div hidden={step !== "details"} className={inTaskSurface ? taskSurfaceStyles.createDetails : "space-y-5"}>
      <Body className={cn("space-y-5", connectStyles.circleCreateDetails)}>
      <h1 className="sr-only">Create a Circle</h1>

      <p className={cn(connectStyles.circleCreateDescription, "text-[color:var(--app-secondary-label)]")}>
        Step 1 of 2 · Name your Circle, then add people now or later.
      </p>

      <label className="flex flex-col gap-2">
        <span className="ui-text-form-label">
          Circle name
        </span>
        <input
          ref={nameInputRef}
          value={name}
          onFocus={() => setNameFocused(true)}
          onBlur={() => {
            setNameFocused(false);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setName(next);
            if (next.trim().length > 0) setNameRequirementActive(false);
          }}
          aria-describedby={nameHelpText ? nameHelpId : undefined}
          aria-invalid={showNameError || undefined}
          maxLength={80}
          autoComplete="off"
          spellCheck
          placeholder="Family, close friends, project team"
          className={cn(
            inTaskSurface ? INPUT_CLASSNAME : "h-[52px] w-full rounded-[14px] border border-transparent bg-[color:var(--app-card-surface-default-solid)] px-4 ui-text-input-value shadow-[var(--app-card-shadow-standard)] outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)] dark:shadow-none",
            showNameError && "ring-2 ring-[#FF3B30]/35 focus:ring-[#FF3B30]/35",
          )}
        />
        {nameHelpText ? (
          <span
            id={nameHelpId}
            className={cn(
              connectStyles.circleCreateDescription,
              "block text-[color:var(--app-secondary-label)]",
              showNameError &&
                "text-[color:var(--app-destructive)]",
            )}
          >
            {nameHelpText}
          </span>
        ) : null}
      </label>

      {showCircleType ? (
        <div className="space-y-2">
          <p
            id="one-location-create-circle-kind-label"
            className="ui-text-form-label"
          >
            Circle type
          </p>
          <div
            role="radiogroup"
            aria-labelledby="one-location-create-circle-kind-label"
            className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-3"
            onKeyDown={(event) => {
              const currentIndex = kindOptions.findIndex(
                (option) => option.value === selectedKind,
              );
              const move = (nextIndex: number) => {
                event.preventDefault();
                const next = kindOptions[nextIndex];
                if (next) {
                  chooseKind(next);
                  event.currentTarget.querySelector<HTMLButtonElement>(
                    `[data-testid="one-location-circle-kind-${next.value}"]`,
                  )?.focus();
                  if (nameMissing) setNameRequirementActive(true);
                }
              };
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                move((currentIndex + 1) % kindOptions.length);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                move(
                  (currentIndex - 1 + kindOptions.length) % kindOptions.length,
                );
              } else if (event.key === "Home") {
                move(0);
              } else if (event.key === "End") {
                move(kindOptions.length - 1);
              }
            }}
          >
            {kindOptions.map((option) => {
              const selected = selectedKind === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  tabIndex={selected ? 0 : -1}
                  data-testid={`one-location-circle-kind-${option.value}`}
                  onClick={() => {
                    chooseKind(option);
                    if (nameMissing) setNameRequirementActive(true);
                  }}
                  className={cn(
                    "ui-text-form-label",
                    inTaskSurface ? "flex min-h-12 items-center justify-start gap-2 rounded-[14px] border px-3 py-3 text-[14px] font-semibold leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]" : "flex h-12 items-center justify-center gap-1.5 rounded-[14px] border px-3 text-[15px] font-semibold leading-5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)]",
                    selected
                      ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)] text-[color:var(--app-primary-label)]"
                      : "border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] text-[color:var(--app-primary-label)] hover:bg-[color:var(--app-secondary-fill)]",
                  )}
                >
                  {selected ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
                  {option.label}
                </button>
              );
            })}
          </div>
          {model.customTypesSupported && kind === "other" ? (
            <label className="flex flex-col gap-2">
              <span className="ui-text-form-label">Type name (optional)</span>
              <input aria-label="Type name (optional)" className={INPUT_CLASSNAME} value={model.customTypeLabel} maxLength={MAX_CIRCLE_TYPE_LABEL_LENGTH}
                placeholder="For example, Finance" onChange={event => model.setCustomTypeLabel(event.target.value)}
                aria-invalid={Boolean(model.typeError)} aria-describedby="circle-custom-type-help" />
              <span id="circle-custom-type-help" className={cn(connectStyles.circleCreateDescription, model.typeError ? "text-destructive" : "text-muted-foreground")}>
                {model.typeError || "Reuse this type for other circles. You can keep up to 3 custom types."}
              </span>
            </label>
          ) : null}
        </div>
      ) : null}

      </Body>
      <Footer className={inTaskSurface ? undefined : CIRCLE_SHEET_CTA_CLASSNAME}>
        <Button
          type="button"
          size="prominent"
          disabled={!canSubmit}
          isLoading={busy || saving}
          onClick={() => void submit()}
          className={cn(inTaskSurface ? "ml-auto w-auto" : "w-full", BLOCKED_CTA)}
        >
          {busy || saving ? "Saving…" : "Next"}
        </Button>
      </Footer>
      </div>
    </div>
  );
}

function normalizeCodeInput(value: string): string {
  const upper = value.toUpperCase();
  const codeAfterMarker = upper.match(
    /\bCODE\b[^2-9A-HJ-KM-NP-Z]{0,8}([23456789A-HJ-KM-NP-Z]{4})[\s-]*([23456789A-HJ-KM-NP-Z]{4})[\s-]*([23456789A-HJ-KM-NP-Z]{4})/,
  );
  const hyphenatedCode = upper.match(
    /\b([23456789A-HJ-KM-NP-Z]{4})-([23456789A-HJ-KM-NP-Z]{4})-([23456789A-HJ-KM-NP-Z]{4})\b/,
  );
  const messageCode = codeAfterMarker ?? hyphenatedCode;
  const isCodeOnlyInput = /^[\s2-9A-HJ-KM-NP-Z-]*$/.test(upper);
  const normalized = (
    messageCode
      ? messageCode.slice(1, 4).join("")
      : isCodeOnlyInput
        ? upper.replace(/[^2-9A-HJ-KM-NP-Z]/g, "")
        : ""
  ).slice(0, 12);
  return normalized.replace(/(.{4})(?=.)/g, "$1-");
}

export function JoinCircleFlow({
  busy,
  onResolve,
  onJoin,
  initialCode,
}: {
  busy: boolean;
  onResolve: (code: string) => Promise<OneLocationCircleInvitePreview>;
  onJoin: (code: string) => Promise<void>;
  /** Pre-fills the code input when arriving from a `/circle/join?code=` link. */
  initialCode?: string;
}) {
  const [code, setCode] = useState(() => normalizeCodeInput(initialCode ?? ""));
  const [resolved, setResolved] = useState<{
    code: string;
    preview: OneLocationCircleInvitePreview;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Confirm before discarding a reviewed preview: "Use Another Code" is one
  // accidental tap away from wiping the circle just reviewed.
  const [discardPreviewConfirmOpen, setDiscardPreviewConfirmOpen] =
    useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const [pasting, setPasting] = useState(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const initialAutoResolvedCodeRef = useRef<string | null>(null);
  const resolveRequestRef = useRef(0);
  const preview = resolved?.preview ?? null;
  const normalizedLength = code.replace(/-/g, "").length;
  const codeGroups = [0, 1, 2].map((index) => code.split("-")[index] ?? "");

  const updateCode = (next: string) => {
    resolveRequestRef.current += 1;
    setCode(next);
    setResolved(null);
    setError(null);
  };

  const pasteCode = (text: string) => {
    const next = normalizeCodeInput(text);
    if (next.replace(/-/g, "").length !== 12) {
      resolveRequestRef.current += 1;
      setResolved(null);
      setError("Enter a valid 12-character Circle invite code.");
      return;
    }
    updateCode(next);
    window.requestAnimationFrame(() => codeInputRefs.current[2]?.focus());
  };

  const pasteFromClipboard = async () => {
    const version = resolveRequestRef.current;
    setPasting(true);
    try {
      if (!navigator.clipboard?.readText) throw new Error("Clipboard unavailable");
      const text = await navigator.clipboard.readText();
      if (version !== resolveRequestRef.current) return;
      pasteCode(text);
    } catch {
      if (version !== resolveRequestRef.current) return;
      setError("Clipboard access is unavailable. Touch and hold a code field to paste, or type the code.");
      window.requestAnimationFrame(() => inputRef.current?.focus());
    } finally {
      setPasting(false);
    }
  };

  const resolve = useCallback(
    async (candidateCode = code) => {
      const requestedCode = normalizeCodeInput(candidateCode);
      if (requestedCode.replace(/-/g, "").length !== 12) return;
      const requestId = ++resolveRequestRef.current;
      try {
        setError(null);
        const nextPreview = await onResolve(requestedCode);
        if (requestId !== resolveRequestRef.current) return;
        setResolved({ code: requestedCode, preview: nextPreview });
        window.requestAnimationFrame(() => previewRef.current?.focus());
      } catch (error) {
        if (requestId !== resolveRequestRef.current) return;
        setResolved(null);
        setError(
          circleFlowErrorMessage(
            error,
            "That Circle code is invalid or no longer available.",
          ),
        );
      }
    },
    [code, onResolve],
  );

  useEffect(() => {
    const initialNormalized = normalizeCodeInput(initialCode ?? "");
    if (initialNormalized.replace(/-/g, "").length !== 12) return;
    if (initialAutoResolvedCodeRef.current === initialNormalized) return;
    initialAutoResolvedCodeRef.current = initialNormalized;
    setCode(initialNormalized);
    setResolved(null);
    setError(null);
    void resolve(initialNormalized);
  }, [initialCode, resolve]);

  // Same guard as CreateCircleFlow, for the same reason: joining navigates on
  // success, and the button comes back before the navigation lands.
  const joiningRef = useRef(false);
  const join = async () => {
    if (!resolved) return;
    if (joiningRef.current) return;
    joiningRef.current = true;
    try {
      await onJoin(resolved.code);
    } catch (error) {
      joiningRef.current = false;
      setError(circleFlowErrorMessage(error, "Could not join this Circle."));
    }
  };

  // The exact flow "Use Another Code" always ran: drop the reviewed preview
  // and hand focus back to the code field. It only runs after the confirm
  // dialog below answers Yes.
  const clearPreviewForAnotherCode = useCallback(() => {
    resolveRequestRef.current += 1;
    setCode("");
    setResolved(null);
    setError(null);
    setDiscardPreviewConfirmOpen(false);
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  return (
    <div className="space-y-5" data-profile-type-scale="circles" data-testid="one-location-join-circle-flow">
      <h1 className="sr-only">Join a Circle</h1>

      <div className="space-y-4">
        <div className="space-y-2">
          <p data-profile-role="label" id="one-location-join-code-label" className="text-[17px] font-semibold leading-[22px] text-foreground">
            Enter invite code
          </p>
        </div>
        <fieldset
          aria-labelledby="one-location-join-code-label"
          disabled={busy || pasting}
          className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 sm:gap-3"
        >
          {codeGroups.map((group, index) => (
            <Fragment key={index}>
              {index > 0 ? <span aria-hidden="true" className="text-[18px] text-[color:var(--app-secondary-label)]">-</span> : null}
              <input
                ref={(node) => {
                  codeInputRefs.current[index] = node;
                  if (index === 0) inputRef.current = node;
                }}
                value={group}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value.length > 4) {
                    pasteCode(value);
                    return;
                  }
                  const next = value.toUpperCase().replace(/[^2-9A-HJ-KM-NP-Z]/g, "");
                  const groups = [...codeGroups];
                  groups[index] = next;
                  updateCode(groups.join("-"));
                  if (next.length === 4 && index < 2) {
                    codeInputRefs.current[index + 1]?.focus();
                    codeInputRefs.current[index + 1]?.select();
                  }
                }}
                onPaste={(event) => {
                  const text = event.clipboardData.getData("text");
                  if (text.length > 4) {
                    event.preventDefault();
                    pasteCode(text);
                  }
                }}
                maxLength={4}
                inputMode="text"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                aria-label={index === 0 ? "Circle invite code" : `Circle invite code, characters ${index * 4 + 1} to ${index * 4 + 4}`}
                aria-describedby={error ? "one-location-join-circle-error" : undefined}
                aria-invalid={error ? true : undefined}
                placeholder={["ABCD", "EFGH", "KMNP"][index]}
                className={cn(
                  "h-14 w-full min-w-0 rounded-[12px] border border-[#D1D1D6] bg-white px-1.5 text-center font-mono text-[18px] font-semibold uppercase tracking-[0.1em] text-[#1C1C1E] outline-none transition focus:border-[color:var(--app-accent)] focus:ring-2 focus:ring-[color:var(--app-accent-ring)]",
                  error && "border-[#FF3B30] focus:border-[#FF3B30] focus:ring-[#FF3B30]/20",
                )}
                onKeyDown={(event) => {
                  if (event.key === "Backspace" && !group && index > 0) {
                    event.preventDefault();
                    codeInputRefs.current[index - 1]?.focus();
                  }
                  if (event.key === "Enter" && normalizedLength === 12 && !busy && !pasting) {
                    event.preventDefault();
                    void resolve();
                  }
                }}
              />
            </Fragment>
          ))}
        </fieldset>
        {error ? (
          <span
            id="one-location-join-circle-error"
            role="alert"
            className="block text-[13px] font-medium leading-[18px] text-[color:var(--app-destructive)]"
          >
            {error}
          </span>
        ) : null}
      </div>

      {preview ? (
        <div
          ref={previewRef}
          tabIndex={-1}
          role="status"
          aria-live="polite"
          className="rounded-[18px] border border-[color:var(--app-card-border-standard)] bg-[color:var(--app-card-surface-default-solid)] p-4 shadow-[var(--app-card-shadow-standard)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-accent-ring)] dark:shadow-none"
        >
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-[13px] bg-[color:var(--app-accent-soft)]",
                CIRCLE_PEOPLE_GLYPH,
              )}
            >
              <UsersRound className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p data-profile-role="name" className="truncate text-[17px] font-semibold leading-[22px] text-foreground">
                {preview.name}
              </p>
              <p data-profile-role="description" className="text-[14px] leading-5 text-[color:var(--app-secondary-label)]">
                {connectPersonName({ displayName: preview.ownerDisplayName })} ·{" "}
                {preview.memberCount === 1
                  ? "1 member"
                  : `${preview.memberCount} members`}
              </p>
            </div>
          </div>
          {preview.alreadyMember ? (
            <p data-profile-role="label" className="mt-3 text-foreground">
              You&apos;re already in this Circle.
            </p>
          ) : null}
          <p data-profile-role="description" className="mt-3 text-[14px] leading-5 text-[color:var(--app-secondary-label)]">
            Location and SMS stay private until you choose to share.
          </p>
        </div>
      ) : null}

      {preview ? (
        <FlowActionGroup
          stacked
          secondary={
            <Button
              type="button"
              variant="ghost"
              size="standard"
              disabled={busy}
              onClick={() => setDiscardPreviewConfirmOpen(true)}
              className={cn("h-[52px] min-h-[52px] bg-[#F0F0F0] text-[#0088FF] hover:bg-[#E5E5EA]", LOCATION_ACTION_SHAPE)}
            >
              Use Another Code
            </Button>
          }
          primary={
            <Button
              type="button"
              size="prominent"
              onClick={() => void join()}
              isLoading={busy}
              disabled={busy}
              className={cn("h-[52px] min-h-[52px] bg-[#0088FF] text-white hover:bg-[#0088FF]", LOCATION_ACTION_SHAPE)}
            >
              {busy
                ? preview.alreadyMember
                  ? "Opening…"
                  : "Joining…"
                : preview.alreadyMember
                  ? "Open Circle"
                  : "Join Circle"}
            </Button>
          }
        />
      ) : (
        <div className="space-y-3">
        <Button
          type="button"
          size="prominent"
          disabled={normalizedLength !== 12 || busy || pasting}
          isLoading={busy}
          onClick={() => void resolve()}
          className={cn("h-[52px] min-h-[52px] w-full bg-[#0088FF] text-white shadow-none hover:bg-[#0088FF]", LOCATION_ACTION_SHAPE, BLOCKED_CTA)}
        >
          {busy ? "Reviewing…" : "Review Circle"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="prominent"
          disabled={busy || pasting}
          isLoading={pasting}
          onClick={() => void pasteFromClipboard()}
          className={cn("h-[52px] min-h-[52px] w-full bg-[#F0F0F0] text-[#0088FF] shadow-none hover:bg-[#E5E5EA]", LOCATION_ACTION_SHAPE)}
        >
          Paste from clipboard
        </Button>
        </div>
      )}

      {/* Confirm before discarding a reviewed preview: one accidental tap on
          "Use Another Code" used to wipe the circle just reviewed with no way
          back. Yes runs the same clear-and-refocus flow; No keeps the preview.
          At root level (not inside the preview conditional) so the dialog
          survives the state change it confirms. */}
      <AlertDialog
        open={discardPreviewConfirmOpen}
        onOpenChange={setDiscardPreviewConfirmOpen}
      >
        <TaskAlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Use another code?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you don&apos;t want to join this circle and want to
              check another one? The preview will be cleared.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>No</AlertDialogCancel>
            <AlertDialogAction onClick={clearPreviewForAnotherCode}>
              Yes
            </AlertDialogAction>
          </AlertDialogFooter>
        </TaskAlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Ties the visible "Circle name" label to its input without wrapping the
 *  trailing Save/Edit button in the `<label>` (a wrapped button steals the
 *  label's activation click and refocuses the field mid-tap). */
const CIRCLE_NAME_INPUT_ID = "one-location-circle-name-input";

/** Names the roster section for `aria-labelledby`, so the list announces as
 *  "Members" rather than as an unlabelled region between two cards. */
const CIRCLE_MEMBERS_HEADING_ID = "one-location-circle-members-heading";

function CircleMemberRow({
  member,
  currentUserId,
  isOwner,
  busy,
  onShare,
  onRemove,
  onConnect,
  connecting = false,
  onCancelRequest,
  cancelling = false,
}: {
  member: OneLocationCircleMember;
  currentUserId: string | null;
  isOwner: boolean;
  busy: boolean;
  onShare: () => void;
  onRemove: () => Promise<void>;
  /** Sends a connection request to this member. Absent when none is possible. */
  onConnect?: () => Promise<void>;
  connecting?: boolean;
  /** Takes back a request this person has not answered yet.
   *
   *  Absent on a surface that cannot cancel, where the row falls back to a
   *  plain "Requested" status. */
  onCancelRequest?: () => Promise<void>;
  cancelling?: boolean;
}) {
  const isCurrentUser = member.userId === currentUserId;
  const memberName = connectPersonName(member);
  // Phone verification is required for emergency SMS, not private location
  // shares. The sharing flow rechecks the current recipient key before review.
  const canShare = !isCurrentUser && member.secureLocationReady;
  const canRemove = isOwner && member.role !== "owner";

  const relationship =
    !isCurrentUser && member.relationship && member.relationship !== "self"
      ? member.relationship
      : null;
  const cta = relationship ? relationshipCta(relationship) : null;

  /**
   * Only a control the viewer can actually press gets to look like one.
   *
   * Every row used to render `relationshipCta` as a button whatever it said,
   * so a roster of people you already know was a column of grey, dead,
   * button-shaped "Connected" -- the loudest thing on the screen, repeated
   * once per member, saying the one thing that is true of a roster by
   * default. Reported as exactly that: "why is there a need to show the
   * connected section with their name".
   *
   * Connected is now silent (visually -- it stays in the row's accessible
   * name below, because absence is not something a screen reader can read),
   * and the two states that are NOT the default keep their own affordance.
   */
  const actionCta = cta && cta.action !== "none" ? cta : null;
  /** Waiting on them.
   *
   *  This used to be a status and nothing more, on the reasoning that nothing
   *  here could act on it. The Connect directory has always been able to --
   *  it offers Cancel on exactly this state -- so the roster showed the same
   *  fact with one fewer thing you could do about it. Where a caller can
   *  cancel, the row does; where it cannot, the status is still the answer. */
  const pendingLabel =
    cta && cta.action === "none" && relationship === "pending_outgoing"
      ? cta.label
      : null;
  const canCancelRequest = Boolean(pendingLabel && onCancelRequest);

  const secondaryLine = isCurrentUser
    ? member.role === "owner"
      ? "You · Owner"
      : "You"
    : member.role === "owner"
      ? "Owner"
      : member.secureLocationReady
        ? "Connected"
        : "Location setup needed";
  // The one second line that is asking for something rather than reporting.
  const secondaryNeedsSetup =
    member.role !== "owner" && !member.secureLocationReady;
  const hasRelationshipControl = Boolean(pendingLabel || actionCta);

  return (
    <div className={CIRCLE_MEMBER_ROW_CLASSNAME}>
      <ConnectionPersonAvatar
        label={memberName}
        photoUrl={member.photoUrl}
        fromContacts={member.connectedFromContacts}
        size="list"
        verified={Boolean(member.isRia)}
        className={CIRCLE_MEMBER_AVATAR_CLASSNAME}
      />
      <div
        className={cn(
          "min-w-0 flex-1",
          hasRelationshipControl && CIRCLE_MEMBER_ACTION_COPY_CLASSNAME,
        )}
      >
        <p data-profile-role="name" className={cn(CIRCLE_MEMBER_NAME_ROW_CLASSNAME, "flex items-center gap-1.5")}>
          <span data-profile-role="name" className={CIRCLE_MEMBER_NAME_CLASSNAME} title={memberName}>
            {memberName}
          </span>
        </p>
        <p data-profile-role="description"
          className={cn(
            MUTED_TEXT,
            CIRCLE_MEMBER_SECONDARY_CLASSNAME,
            // The amber pair `WARNING_SURFACE` already uses for caution copy,
            // not the flat `--app-warning`: that token is the #ff9500 glyph
            // tone and measures ~2.2:1 on this card, well under the 4.5:1 a
            // 13px sentence needs.
            secondaryNeedsSetup && "text-amber-700 dark:text-amber-300",
          )}
        >
          {secondaryLine}
        </p>
        {/* Said once, to the accessibility tree only. The visible row drops
            the default relationship rather than repeating it down the list. */}
        {cta && !actionCta && !pendingLabel ? (
          <span className="sr-only">Connected on One</span>
        ) : null}
      </div>
      <div
        className={cn(
          CIRCLE_MEMBER_TRAILING_CLASSNAME,
          hasRelationshipControl && CIRCLE_MEMBER_STACKED_ACTION_CLASSNAME,
        )}
      >
        <div className="flex shrink-0 items-center justify-end gap-1">
        {pendingLabel && !canCancelRequest ? (
          <span
            className="px-1 text-[13px] font-medium leading-5 text-muted-foreground"
            data-testid={`circle-member-relationship-${member.userId}`}
          >
            {pendingLabel}
          </span>
        ) : null}
        {canCancelRequest ? (
          // One word, at the width the other actions in this column use. The
          // directory settled that: "Cancel request" made the widest control
          // on the screen the one belonging to the least common row state.
          <Button
            type="button"
            variant="outline"
            size="compact"
            disabled={busy || cancelling}
            isLoading={cancelling}
            aria-label={`Cancel your request to ${memberName}`}
            data-testid={`circle-member-cancel-${member.userId}`}
            className={CIRCLE_MEMBER_ACTION_CLASSNAME}
            onClick={() => void onCancelRequest?.()}
          >
            Cancel
          </Button>
        ) : null}
        {actionCta?.action === "connect" ? (
          <Button
            type="button"
            size="compact"
            disabled={busy || connecting}
            isLoading={connecting}
            aria-label={`Connect with ${memberName}`}
            data-testid={`circle-member-connect-${member.userId}`}
            className={CIRCLE_MEMBER_ACTION_CLASSNAME}
            onClick={() => void onConnect?.()}
          >
            {actionCta.label}
          </Button>
        ) : null}
        {/* `pending_incoming` used to render an ENABLED button whose click
            handler ran only for `action === "connect"` -- so the one row that
            had something waiting on it offered a control that did nothing at
            all. Answering an incoming request lives on Connect, and this is
            now the link that goes there. */}
        {actionCta?.action === "respond" ? (
          <>
            {/* `Link`, not a bare anchor. An <a href> is a full document
              load, and the vault key lives only in React state -- so the
              one control offered here relocked the vault on the way to
              using it. */}
            <Link
              // The consent centre, not `/one/connect`.
              //
              // From a Circle hosted ON Connect, a bare `/one/connect` href is
              // a navigation whose only change is the query string
              // disappearing -- which this repo has measured the App Router to
              // refuse -- so the one row with something waiting on it did
              // nothing at all when tapped. Connect's own Respond goes here
              // too, and a different pathname works from either host.
              href={buildConsentCenterHref("pending")}
              aria-label={`Respond to the connection request from ${memberName}`}
              data-testid={`circle-member-respond-${member.userId}`}
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                CIRCLE_MEMBER_ACTION_CLASSNAME,
              )}
            >
              {actionCta.label}
            </Link>
          </>
        ) : null}
        {/* The kebab, its actions and the confirm they lead to -- one module,
            because which SURFACE carries them depends on the pointer. See
            `circle-member-actions-menu.tsx`: a phone gets a bottom action
            sheet headed by this member's own name, a desktop keeps the
            anchored menu. It also renders the inert 44px spacer on the rows
            that offer nothing, so the kebab column exists on every row. */}
        <CircleMemberActionsMenu
          displayName={memberName}
          profileHref={
            member.publicPersonRef
              ? buildPersonProfileRoute(member.publicPersonRef, {
                  from: ROUTES.ONE_LOCATION,
                })
              : null
          }
          messageHref={
            relationship === "connected" && member.publicPersonRef
              ? buildDirectMessageRoute({
                  personRef: member.publicPersonRef,
                })
              : null
          }
          initials={circleInitials(memberName)}
          photoUrl={member.photoUrl}
          verified={Boolean(member.isRia)}
          secondaryLine={secondaryLine}
          canShare={canShare}
          canRemove={canRemove}
          busy={busy}
          onShare={onShare}
          onRemove={onRemove}
        />
        </div>
      </div>
    </div>
  );
}

function CircleMembersLoading() {
  return <div role="status" aria-label="Loading circle members" className="space-y-3 rounded-[18px] border border-border bg-card p-4">
    <span className="sr-only">Loading circle members…</span>
    {[0, 1, 2].map((row) => <div key={row} aria-hidden="true" className="flex min-h-14 items-center gap-3">
      <div className="size-10 shrink-0 rounded-full bg-muted animate-pulse motion-reduce:animate-none" />
      <div className="flex-1 space-y-2"><div className="h-3 w-1/2 rounded bg-muted animate-pulse motion-reduce:animate-none" /><div className="h-2 w-1/3 rounded bg-muted" /></div>
    </div>)}
  </div>;
}

/** Match the server's Circle name normalization when comparing and saving. */
function normalizeCircleName(value: string): string {
  // Python str.split also treats U+0085 and U+001C–001F as whitespace.
  return value.split(/[\p{White_Space}\u001c-\u001f]+/u).filter(Boolean).join(" ");
}

export function CircleDetailFlow({
  circleId,
  initialCircleSummary,
  sessionScope,
  currentUserId,
  busy,
  onBack,
  onLoad,
  onLoadOverview,
  onLoadMembersPage,
  onRename,
  onGenerateCode,
  onCopyCode,
  onShareCode,
  onShareWithMember,
  onRemoveMember,
  onConnectMember,
  onCancelMemberRequest,
  reloadSignal = 0,
  onLoadEligibleConnections,
  onLoadEligibleConnectionsPage,
  onInviteConnections,
  onCancelMemberInvite,
  onLeave,
  onDelete,
  onProceedToSms,
  livingCircleExperience = false,
  renderChat,
  chatIntent = false,
  memberSetup = false,
  onMemberSetupComplete,
  onPhotoUpdate,
}: {
  circleId: string;
  /** Display identity only; fresh detail remains the sole authority for actions. */
  initialCircleSummary?: Pick<OneLocationCircleSummary, "id" | "name" | "memberCount">;
  /** In-memory unlock identity; never serialized or used as an access grant. */
  sessionScope?: unknown;
  renderChat?: (circle: OneLocationCircleOverview, options: { active: boolean; readingBlocked: boolean }) => ReactNode;
  chatIntent?: boolean;
  /** Creation enters the existing inline member flow; a reload retains it. */
  memberSetup?: boolean;
  onMemberSetupComplete?: () => void;
  onPhotoUpdate?: (circleId: string, photoUrl: string | null) => Promise<OneLocationCircleOverview>;
  currentUserId: string | null;
  busy: boolean;
  onBack: () => void;
  onLoad: (circleId: string) => Promise<OneLocationCircleDetail>;
  /** Bounded read-model path. When both callbacks are present, the complete
   * legacy detail loader is retained for old callers but is not invoked. */
  onLoadOverview?: (circleId: string) => Promise<OneLocationCircleOverview>;
  onLoadMembersPage?: (
    circleId: string,
    options: { page: number; limit: number; query?: string },
  ) => Promise<OneLocationCircleMemberPage>;
  onRename: (
    circleId: string,
    name: string,
  ) => Promise<OneLocationCircleDetail>;
  onGenerateCode: (
    circleId: string,
    rotate?: boolean,
  ) => Promise<OneLocationCircleInviteCode>;
  onCopyCode: (code: string) => Promise<void>;
  onShareCode: (
    circle: OneLocationCircleOverview,
    code: string,
  ) => Promise<void>;
  onShareWithMember: (circleId: string, userId: string) => void;
  onRemoveMember: (circleId: string, userId: string) => Promise<void>;
  /**
   * Sends a connection request to a co-member.
   *
   * Sharing a Circle does not connect two people -- a joiner is paired with
   * whoever invited them and nobody else -- so the roster is where that
   * introduction can be asked for explicitly, and answered by the other person.
   */
  /** `displayName` and `photoUrl` are passed so a caller can put this person
   *  in front of the same capability review the Connect directory uses,
   *  which needs a name to show. Optional so an older caller still compiles. */
  onConnectMember: (
    circleId: string,
    userId: string,
    person?: { displayName: string | null; photoUrl: string | null },
  ) => Promise<void>;
  /** Takes back a request this viewer sent to a co-member. Absent on a
   *  surface that cannot cancel, where the row shows a plain "Requested". */
  onCancelMemberRequest?: (circleId: string, userId: string) => Promise<void>;
  /** Re-read this Circle without disturbing what the person is doing.
   *
   *  Bumped by the caller when something outside this screen changed the
   *  roster -- a request sent, a member added, somebody joining with a code.
   *  Deliberately NOT a `key` remount: that would close an open add-people
   *  sheet, clear a half-typed search and drop the selection, which is a
   *  worse answer than a stale row. */
  reloadSignal?: number;
  onLoadEligibleConnections: (
    circleId: string,
  ) => Promise<OneLocationCircleEligibleConnections>;
  onLoadEligibleConnectionsPage?: (
    circleId: string,
    options: { page: number; limit: number; query?: string },
  ) => Promise<OneLocationCircleEligibleConnectionsPage>;
  onInviteConnections: (
    circleId: string,
    inviteeUserIds: string[],
  ) => Promise<void>;
  onCancelMemberInvite: (inviteId: string) => Promise<void>;
  onLeave: (circleId: string) => Promise<void>;
  onDelete: (circleId: string) => Promise<void>;
  /** SMS Circle only: continue once at least one member besides the owner exists. */
  onProceedToSms?: () => void;
  /** Connect-only enhancement; Location keeps its existing Circle flow. */
  livingCircleExperience?: boolean;
}) {
  const [loadedCircle, setCircle] = useState<
    OneLocationCircleDetail | OneLocationCircleOverview | null
  >(null);
  const [detailView, setDetailView] = useState(memberSetup && !chatIntent ? "members" : "chat");
  const initialViewCircleRef = useRef<string | null>(null);
  const entryChatIntentRef = useRef(chatIntent);
  useEffect(() => {
    initialViewCircleRef.current = null;
    entryChatIntentRef.current = chatIntent;
    setDetailView(memberSetup && !chatIntent ? "members" : "chat");
    // Capture entry intent once per circle. Consuming a transient URL intent
    // must not reset the current tab or redirect an already-open chat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId]);
  useEffect(() => {
    if (!chatIntent) return;
    entryChatIntentRef.current = true;
    setDetailView("chat");
  }, [chatIntent]);
  const [memberRows, setMemberRows] = useState<OneLocationCircleMember[]>([]);
  const [membersLoading, setMembersLoading] = useState(true);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const loadedScopeRef = useRef({ currentUserId, sessionScope });
  const [orbitMembers, setOrbitMembers] = useState<OneLocationCircleMember[]>([]);
  const [memberPage, setMemberPage] = useState(1);
  const [memberHasMore, setMemberHasMore] = useState(false);
  const [memberTotalCount, setMemberTotalCount] = useState(0);
  const [memberLoadingMore, setMemberLoadingMore] = useState(false);
  const [cancellingUserId, setCancellingUserId] = useState<string | null>(null);
  const [inviteCode, setInviteCode] =
    useState<OneLocationCircleInviteCode | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [circleName, setCircleName] = useState("");
  const [peopleSheetOpen, setPeopleSheetOpen] = useState(false);
  const [renameSheetOpen, setRenameSheetOpenState] = useState(false);
  const [photoSheetOpen, setPhotoSheetOpen] = useState(false);
  const [inviteCodeSheetOpen, setInviteCodeSheetOpen] = useState(false);
  const [replaceCodeConfirmOpen, setReplaceCodeConfirmOpen] = useState(false);
  const [codeCopied, setCodeCopied] = useState(false);
  const [eligibleConnections, setEligibleConnections] = useState<
    OneLocationCircleEligibleConnection[]
  >([]);
  const [pendingInvites, setPendingInvites] = useState<
    OneLocationCircleMemberInvite[]
  >([]);
  const [remainingCapacity, setRemainingCapacity] = useState(0);
  const selectionLimit = circleInviteSelectionLimit(remainingCapacity);
  const [peopleSearch, setPeopleSearch] = useState("");
  const [memberSearch, setMemberSearch] = useState("");
  const [selectedConnections, setSelectedConnections] = useState<
    Map<string, OneLocationCircleEligibleConnection>
  >(() => new Map());
  const [peoplePage, setPeoplePage] = useState(1);
  const [peopleHasMore, setPeopleHasMore] = useState(false);
  const [peopleTotalCount, setPeopleTotalCount] = useState(0);
  const [peopleLoadingMore, setPeopleLoadingMore] = useState(false);
  const [peopleLoadError, setPeopleLoadError] = useState<string | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleSubmitting, setPeopleSubmitting] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [cancellingInviteId, setCancellingInviteId] = useState<string | null>(
    null,
  );
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const loadRequestRef = useRef(0);
  const memberRequestRef = useRef(0);
  const lastMemberSearchRef = useRef({ circleId, currentUserId, sessionScope, query: memberSearch, loader: onLoadMembersPage });
  const peopleRequestRef = useRef(0);
  const peopleSubmitInFlightRef = useRef(false);
  const peopleMutationScopeRef = useRef({});
  const cancelInviteInFlightRef = useRef(false);
  const renameDraftRef = useRef({ open: false, dirty: false });
  const renameInFlightRef = useRef(false);
  const renameRequestRef = useRef(0);
  const overviewNameRevisionRef = useRef(0);

  const setRenameSheetOpen = (open: boolean) => {
    renameDraftRef.current = { open, dirty: false };
    setRenameSheetOpenState(open);
  };

  const usesPagedMembers = Boolean(onLoadOverview && onLoadMembersPage);

  const applyOverview = (overview: OneLocationCircleOverview, nameRevision: number) => {
    if (nameRevision !== overviewNameRevisionRef.current) return;
    loadedScopeRef.current = { currentUserId, sessionScope };
    setCircle(overview);
    // Polling and push refreshes must not replace an active rename draft.
    // Read the ref at response time: this read may have started before Edit.
    if (!renameDraftRef.current.open || !renameDraftRef.current.dirty) {
      setCircleName(overview.name);
    }
    setInviteCode(overview.activeInviteCode ?? null);
    if (!(overview.viewerCapabilities?.canInviteMembers ?? overview.role === "owner")) {
      setPeopleSheetOpen(false);
      setSelectedConnections(new Map());
      peopleRequestRef.current += 1;
    }
  };

  const reload = async (memberQuery = memberSearch): Promise<
    OneLocationCircleDetail | OneLocationCircleOverview | null
  > => {
    const requestId = ++loadRequestRef.current;
    const memberRequestId = ++memberRequestRef.current;
    const nameRevision = overviewNameRevisionRef.current;
    setLoadError(null);
    setMembersLoading(true);
    setMemberLoadingMore(false);
    if (!circleId) {
      setCircle(null);
      setLoadError("This Circle link is incomplete.");
      return null;
    }
    try {
      const [nextCircle, nextMembersPage] = usesPagedMembers
        ? await Promise.all([
            onLoadOverview!(circleId).then((overview) => {
              if (requestId === loadRequestRef.current) {
                applyOverview(overview, nameRevision);
              }
              return overview;
            }),
            onLoadMembersPage!(circleId, {
              page: 1,
              limit: 50,
              query: memberQuery.trim() || undefined,
            }),
          ])
        : [await onLoad(circleId), null];
      if (requestId !== loadRequestRef.current) return null;
      // The paged overview is already visible. Reapplying it here would
      // overwrite edits or saved changes made while its roster was pending.
      if (!usesPagedMembers) applyOverview(nextCircle, nameRevision);
      if (memberRequestId !== memberRequestRef.current) return nextCircle;
      setMembersLoading(false);
      setMembersLoaded(true);
      if (nextMembersPage) {
        setMemberRows(nextMembersPage.items);
        if (!memberQuery.trim()) setOrbitMembers(nextMembersPage.items);
        setMemberPage(nextMembersPage.page);
        setMemberHasMore(nextMembersPage.hasMore);
        setMemberTotalCount(nextMembersPage.totalCount);
      } else {
        const completeMembers = (nextCircle as OneLocationCircleDetail).members;
        setMemberRows(completeMembers);
        if (!memberQuery.trim()) setOrbitMembers(completeMembers);
        setMemberPage(1);
        setMemberHasMore(false);
        setMemberTotalCount(completeMembers.length);
      }
      return nextCircle;
    } catch (error) {
      if (requestId !== loadRequestRef.current || memberRequestId !== memberRequestRef.current) return null;
      setMembersLoading(false);
      if (nameRevision !== overviewNameRevisionRef.current) return null;
      setLoadError(
        error instanceof Error ? error.message : "Could not load this Circle.",
      );
      return null;
    }
  };

  useEffect(() => {
    peopleMutationScopeRef.current = {};
    peopleSubmitInFlightRef.current = false;
    setPeopleSubmitting(false);
    setCircle(null);
    setMemberRows([]);
    setMembersLoaded(false);
    setOrbitMembers([]);
    setInviteCode(null);
    setPeopleSheetOpen(false);
    setPeopleSearch("");
    setSelectedConnections(new Map());
    setEligibleConnections([]);
    setPeopleTotalCount(0);
    setRemainingCapacity(0);
    setMemberSearch("");
    setSavingName(false);
    setRenameSheetOpen(false);
    setCircleName("");
    renameInFlightRef.current = false;
    renameRequestRef.current += 1;
    peopleRequestRef.current += 1;
    void reload("");
    // Reset on selection, owner or unlock changes. Unrelated page refreshes
    // must not refetch the focused detail.
    return () => {
      peopleMutationScopeRef.current = {};
      loadRequestRef.current += 1;
      memberRequestRef.current += 1;
      peopleRequestRef.current += 1;
      renameRequestRef.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circleId, currentUserId, sessionScope]);

  // A re-read the caller asked for. Unlike the effect above it resets nothing:
  // the sheet stays open, the search keeps its text, the selection survives.
  const lastReloadSignalRef = useRef(reloadSignal);
  const lastEligibleReloadSignalRef = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === lastReloadSignalRef.current) return;
    lastReloadSignalRef.current = reloadSignal;
    if (!circleId) return;
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadSignal]);

  const scopeMatches = loadedScopeRef.current.currentUserId === currentUserId && loadedScopeRef.current.sessionScope === sessionScope;
  const circle = scopeMatches && loadedCircle?.id === circleId ? loadedCircle : null;
  const summary = initialCircleSummary?.id === circleId ? initialCircleSummary : null;
  const isOwner = circle?.role === "owner";
  const hasChat = Boolean(livingCircleExperience && renderChat && circle && !circle.isSystem && circle.systemKind == null);
  // Stated by the server rather than inferred here.
  //
  // "Owner" and "not the emergency one" stopped being the right test when
  // Trusted arrived: it is deliberately NOT `is_system`, so it fell through to
  // the Delete button, which the API and a database trigger both refuse. The
  // fallbacks reproduce the old inference for a server that does not send the
  // fields yet.
  const canDeleteCircle =
    circle?.viewerCapabilities?.canDeleteCircle ??
    (isOwner && !circle?.isSystem);
  const canLeaveCircle = circle?.viewerCapabilities?.canLeaveCircle ?? !isOwner;
  // Dirty-tracked rename: the trailing control only presents as an explicit
  // "Save" once the typed name differs from the one every member currently
  // sees, so an untouched field never offers a no-op write.
  const trimmedCircleName = normalizeCircleName(circleName);
  const circleNameDirty = Boolean(circle) && trimmedCircleName !== normalizeCircleName(circle?.name ?? "");
  const canSaveCircleName =
    circleNameDirty && trimmedCircleName.length >= 1 && trimmedCircleName.length <= 80 && !savingName && !busy;
  const canInviteMembers =
    circle?.viewerCapabilities?.canInviteMembers ?? Boolean(isOwner);
  const isSmsCircle = Boolean(circle && isSmsSystemCircle(circle));
  const canViewInviteCode =
    circle?.viewerCapabilities?.canViewInviteCode ?? Boolean(isOwner);
  const canRotateInviteCode =
    circle?.viewerCapabilities?.canRotateInviteCode ?? Boolean(isOwner);
  const inviteCodeNeedsOwnerRotation = Boolean(
    circle?.inviteCodeNeedsOwnerRotation,
  );
  const members = memberRows;
  const hasOtherMember = members.some(
    (member) => member.userId !== currentUserId,
  );
  // One request in flight at a time: the roster re-renders from the reloaded
  // Circle, and two overlapping sends would leave the wrong row spinning.
  const [connectingUserId, setConnectingUserId] = useState<string | null>(null);
  // Circle Detail counts the rows it actually renders. The "Your circles" list
  // still uses the other-member summary helper. When member paging is active,
  // use the server total rather than pretending the first page is complete.
  const visibleMemberCount = usesPagedMembers
    ? Number(circle?.memberCount ?? memberTotalCount)
    : members.length;
  const visibleMemberSummary = circleDetailMemberCountLabel(visibleMemberCount);
  const needsFirstMember = Boolean(
    livingCircleExperience && circle && isOwner && canInviteMembers &&
    !circle.isSystem && circle.systemKind == null && circle.memberCount <= 1,
  );
  useEffect(() => {
    if (!circle || initialViewCircleRef.current === circle.id) return;
    initialViewCircleRef.current = circle.id;
    // An unfinished circle remains recoverable after leaving or reopening it.
    // Explicit chat links (including notifications) retain their own intent.
    if (!entryChatIntentRef.current && (memberSetup || needsFirstMember)) setDetailView("members");
  }, [circle, memberSetup, needsFirstMember]);
  const changeDetailView = (view: string) => {
    if (view === "chat" && memberSetup && needsFirstMember && !entryChatIntentRef.current) return;
    setDetailView(view);
    if (view === "chat" && memberSetup) onMemberSetupComplete?.();
  };

  // Filters the already-loaded Members list client-side, same as the "Add
  // people" sheet's connection search — a circle's roster is small enough
  // that there is no server round trip worth making for this.
  const locallyFilteredMembers = useMemo(
    () =>
      filterPeopleByQuery(
        sortPeopleByName(members, (member) => member.displayName),
        memberSearch,
        (member) => member.displayName,
      ),
    [members, memberSearch],
  );
  // The owner leads the roster in every kind of Circle, from either source --
  // but only while the roster is a ROSTER. Once a query is typed the list is
  // answering that query, and both search paths now rank a name that begins
  // with what you typed above one that merely contains it (client-side in
  // `filterPeopleByQuery`, server-side since #6244). Hoisting the owner
  // through that would put a loose match above an exact one, on the one
  // screen where the reader has already said who they are looking for.
  // `circle-member-order.ts` documents why this is a partition rather than a
  // second key on the A-Z sort.
  const filteredMembers = useMemo(() => {
    const rendered = usesPagedMembers ? members : locallyFilteredMembers;
    return memberSearch.trim()
      ? rendered
      : sortCircleMembersOwnerFirst(rendered);
  }, [usesPagedMembers, members, locallyFilteredMembers, memberSearch]);

  // Beside the "Members" heading. Unfiltered it is the same phrase the screen
  // title and the "Your circles" row use, so the number never changes wording
  // between the three places it appears; filtered it reports the match count
  // against the roster, because that is the list actually on screen.
  const memberCountLabel = memberSearch.trim()
    ? usesPagedMembers
      ? `${memberTotalCount} ${memberTotalCount === 1 ? "match" : "matches"}`
      : `${filteredMembers.length} of ${members.length}`
    : visibleMemberSummary;
  const showMemberSearch = livingCircleExperience ||
    (usesPagedMembers
      ? Math.max(memberTotalCount, visibleMemberCount)
      : members.length) >= 8 || memberSearch.trim().length > 0;

  useEffect(() => {
    if (!usesPagedMembers || !circleId || !onLoadMembersPage) return;
    const previous = lastMemberSearchRef.current;
    const scopeChanged = previous.circleId !== circleId || previous.currentUserId !== currentUserId || previous.sessionScope !== sessionScope;
    lastMemberSearchRef.current = { circleId, currentUserId, sessionScope, query: scopeChanged ? "" : memberSearch, loader: onLoadMembersPage };
    // reload owns the initial roster and scope resets; search only reads a
    // changed query. All roster reads share one generation with pagination.
    if (scopeChanged || (previous.query === memberSearch && previous.loader === onLoadMembersPage)) return;
    const requestId = ++memberRequestRef.current;
    setMembersLoading(true);
    setMemberLoadingMore(false);
    setLoadError(null);
    const timer = window.setTimeout(() => {
      void onLoadMembersPage(circleId, {
        page: 1,
        limit: 50,
        query: memberSearch.trim() || undefined,
      })
        .then((result) => {
          if (requestId !== memberRequestRef.current) return;
          setMemberRows(result.items);
          setMembersLoading(false);
          setMembersLoaded(true);
          if (!memberSearch.trim()) setOrbitMembers(result.items);
          setMemberPage(result.page);
          setMemberHasMore(result.hasMore);
          setMemberTotalCount(result.totalCount);
        })
        .catch((error) => {
          if (requestId !== memberRequestRef.current) return;
          setMembersLoading(false);
          setLoadError(
            circleFlowErrorMessage(error, "Could not load Circle members."),
          );
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      if (requestId === memberRequestRef.current) memberRequestRef.current += 1;
    };
  }, [circleId, currentUserId, sessionScope, memberSearch, onLoadMembersPage, usesPagedMembers]);

  const loadMoreMembers = async () => {
    if (!onLoadMembersPage || !memberHasMore || membersLoading || memberLoadingMore) return;
    const requestId = ++memberRequestRef.current;
    setMemberLoadingMore(true);
    try {
      const result = await onLoadMembersPage(circleId, {
        page: memberPage + 1,
        limit: 50,
        query: memberSearch.trim() || undefined,
      });
      if (requestId !== memberRequestRef.current) return;
      setMemberRows((current) => {
        const byUserId = new Map(
          current.map((member) => [member.userId, member]),
        );
        for (const member of result.items) byUserId.set(member.userId, member);
        return [...byUserId.values()];
      });
      setMemberPage(result.page);
      setMemberHasMore(result.hasMore);
      setMemberTotalCount(result.totalCount);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not load more members."),
      );
    } finally {
      if (requestId === memberRequestRef.current) setMemberLoadingMore(false);
    }
  };

  const locallyFilteredEligibleConnections = useMemo(
    () =>
      // Sorted before filtering, like every other people picker in Location.
      // These two sheets were rendering whatever order the server returned, so
      // the same two connections could swap places between two openings and a
      // long list had nowhere to start looking.
      filterPeopleByQuery(
        sortPeopleByName(
          eligibleConnections,
          (connection) => connection.displayName,
        ),
        peopleSearch,
        (connection) => connection.displayName,
      ),
    [eligibleConnections, peopleSearch],
  );
  const filteredEligibleConnections = onLoadEligibleConnectionsPage
    ? eligibleConnections
    : locallyFilteredEligibleConnections;

  const loadEligibleConnections = async ({
    page = 1,
    append = false,
    query = peopleSearch,
    reconcileSelections = false,
  }: {
    page?: number;
    append?: boolean;
    query?: string;
    /** A remote mutation may invalidate a selection that is not on the
     *  currently rendered page. Pair the paged display read with the bounded
     *  full eligible set before trimming selections. */
    reconcileSelections?: boolean;
  } = {}) => {
    if (!circle || !canInviteMembers) return;
    const requestId = ++peopleRequestRef.current;
    if (append) setPeopleLoadingMore(true);
    else setPeopleLoading(true);
    setPeopleLoadError(null);
    try {
      let authoritativeResult: OneLocationCircleEligibleConnections | null =
        null;
      const result = onLoadEligibleConnectionsPage
        ? reconcileSelections
          ? await Promise.all([
              onLoadEligibleConnectionsPage(circle.id, {
                page,
                limit: 50,
                query: query.trim() || undefined,
              }),
              onLoadEligibleConnections(circle.id),
            ]).then(([paged, authoritative]) => {
              authoritativeResult = authoritative;
              return paged;
            })
          : await onLoadEligibleConnectionsPage(circle.id, {
              page,
              limit: 50,
              query: query.trim() || undefined,
            })
        : await onLoadEligibleConnections(circle.id);
      if (requestId !== peopleRequestRef.current) return;
      setEligibleConnections((current) => {
        if (!append) return result.eligibleConnections;
        const byUserId = new Map(
          current.map((connection) => [connection.userId, connection]),
        );
        for (const connection of result.eligibleConnections) {
          byUserId.set(connection.userId, connection);
        }
        return [...byUserId.values()];
      });
      const authoritative = authoritativeResult ?? result;
      setPendingInvites(authoritative.pendingInvites);
      setRemainingCapacity(authoritative.remainingCapacity);
      // A partial page cannot invalidate an off-page connection, but its
      // authoritative capacity still bounds the batch the button promises.
      if (onLoadEligibleConnectionsPage && !authoritativeResult) {
        setSelectedConnections((current) => new Map(
          [...current].slice(0, circleInviteSelectionLimit(authoritative.remainingCapacity)),
        ));
      }
      const pagedResult = onLoadEligibleConnectionsPage
        ? (result as OneLocationCircleEligibleConnectionsPage)
        : null;
      setPeoplePage(pagedResult?.page ?? 1);
      setPeopleHasMore(pagedResult?.hasMore ?? false);
      setPeopleTotalCount(
        pagedResult?.totalCount ?? result.eligibleConnections.length,
      );
      // Appending page 2 proves nothing about a selection from page 1. Trim
      // only when this response is the complete authority (non-paged) or the
      // explicit remote-change reconciliation fetched that authority beside
      // the visible page.
      if (!onLoadEligibleConnectionsPage || authoritativeResult) {
        const eligibleByUserId = new Map(
          authoritative.eligibleConnections.map((connection) => [
            connection.userId,
            connection,
          ]),
        );
        setSelectedConnections((current) =>
          new Map(
            [...current]
              .filter(([userId]) => eligibleByUserId.has(userId))
              .map(
                ([userId]) =>
                  [userId, eligibleByUserId.get(userId)!] as const,
              )
              .slice(
                0,
                circleInviteSelectionLimit(authoritative.remainingCapacity),
              ),
          ),
        );
      }
    } catch (error) {
      if (requestId !== peopleRequestRef.current) return;
      setPeopleLoadError(
        circleFlowErrorMessage(error, "Could not load your connections."),
      );
    } finally {
      if (requestId === peopleRequestRef.current) {
        setPeopleLoading(false);
        setPeopleLoadingMore(false);
      }
    }
  };

  const openPeopleSheet = () => {
    if (!circle || !canInviteMembers) return;
    setPeopleSheetOpen(true);
    setPeopleSearch("");
    setSelectedConnections(new Map());
    void loadEligibleConnections();
  };


  useEffect(() => {
    if (reloadSignal === lastEligibleReloadSignalRef.current) return;
    lastEligibleReloadSignalRef.current = reloadSignal;
    if ((!peopleSheetOpen && !livingCircleExperience) || !circle) return;
    // A relationship removed in Connect must disappear from an already-open
    // picker too. Reload in place so search text and the sheet stay put; the
    // response also trims selections that no longer fit the authoritative
    // eligible set.
    void loadEligibleConnections({
      page: 1,
      query: peopleSheetOpen || livingCircleExperience ? peopleSearch : "",
      reconcileSelections: peopleSheetOpen || livingCircleExperience,
    });
    // This effect is signal-driven. Capturing the current loader is intended;
    // depending on its render-local identity would refetch on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [circle?.id, livingCircleExperience, peopleSearch, peopleSheetOpen, reloadSignal]);

  const previousPeopleSearchRef = useRef("");
  useEffect(() => {
    const changed = previousPeopleSearchRef.current !== peopleSearch;
    previousPeopleSearchRef.current = peopleSearch;
    if (!changed || !peopleSheetOpen || !onLoadEligibleConnectionsPage || !circle) return;
    const timer = window.setTimeout(() => {
      void loadEligibleConnections({ page: 1, query: peopleSearch });
    }, 250);
    return () => window.clearTimeout(timer);
    // The loader intentionally follows the current Circle/sheet/search only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    circle?.id,
    onLoadEligibleConnectionsPage,
    peopleSearch,
    peopleSheetOpen,
  ]);

  const sendMemberInvites = async () => {
    if (
      !circle ||
      !canInviteMembers ||
      peopleSubmitInFlightRef.current ||
      !selectedConnections.size
    ) {
      return;
    }
    const inviteeUserIds = [...selectedConnections.keys()].slice(
      0,
      selectionLimit,
    );
    if (!inviteeUserIds.length) return;
    const scope = peopleMutationScopeRef.current;
    peopleSubmitInFlightRef.current = true;
    setPeopleSubmitting(true);
    try {
      await onInviteConnections(circle.id, inviteeUserIds);
      if (scope !== peopleMutationScopeRef.current) return;
      toast.success(
        inviteeUserIds.length === 1
          ? "Added to the Circle."
          : `${inviteeUserIds.length} people added to the Circle.`,
      );
      // Adding is the sheet's terminal action for any selection size, so close
      // it and let the toast confirm. Bump the request ref first so a slower
      // in-flight eligibility load cannot repopulate a dismissed sheet, and
      // reload the detail behind it to pick up the new members.
      peopleRequestRef.current += 1;
      setSelectedConnections(new Map());
      setPeopleSearch("");
      setPeopleSheetOpen(false);
      await reload();
      if (scope !== peopleMutationScopeRef.current) return;
      if (livingCircleExperience) {
        await loadEligibleConnections({ page: 1, query: "" });
      }
    } catch (error) {
      if (scope !== peopleMutationScopeRef.current) return;
      toast.error(circleFlowErrorMessage(error, "Could not add them."));
      // A capacity/eligibility conflict means this selected set is no longer
      // authoritative. Clear it before the bounded page refresh; intersecting
      // with one partial page would incorrectly preserve or discard rows.
      setSelectedConnections(new Map());
      // Capacity or eligibility may have changed while the sheet was open.
      // Reconcile against the server before another tap so stale selections
      // are trimmed rather than repeatedly submitting a known conflict.
      const refreshedCircle = await reload();
      if (scope !== peopleMutationScopeRef.current) return;
      const stillCanInvite =
        refreshedCircle?.viewerCapabilities?.canInviteMembers ??
        refreshedCircle?.role === "owner";
      if (stillCanInvite) {
        await loadEligibleConnections();
      } else {
        setPeopleSheetOpen(false);
      }
    } finally {
      if (scope === peopleMutationScopeRef.current) {
        peopleSubmitInFlightRef.current = false;
        setPeopleSubmitting(false);
      }
    }
  };

  const toggleInlineConnection = (userId: string) => {
    if (!canInviteMembers || peopleSubmitInFlightRef.current) return;
    const person = eligibleConnections.find((candidate) => candidate.userId === userId);
    setSelectedConnections((current) => {
      if (!current.has(userId) && !person) return current;
      const next = new Map(current);
      if (next.has(userId)) next.delete(userId);
      else if (person && next.size < selectionLimit) next.set(userId, person);
      return next;
    });
  };

  const addInlineConnections = async () => {
    if (
      !circle ||
      !canInviteMembers ||
      peopleSubmitInFlightRef.current ||
      peopleLoadError ||
      !selectedConnections.size
    ) {
      return;
    }
    const userIds = [...selectedConnections.keys()];
    if (!userIds.length || userIds.length > selectionLimit) return;
    const scope = peopleMutationScopeRef.current;
    peopleSubmitInFlightRef.current = true;
    setPeopleSubmitting(true);
    try {
      // Selection is local and instant, like SMS Circle. Membership continues
      // to come exclusively from the existing atomic batch mutation and reads.
      await onInviteConnections(circle.id, userIds);
      if (scope !== peopleMutationScopeRef.current) return;
      toast.success("Circle members updated.");
      setPeopleSheetOpen(false);
      peopleRequestRef.current += 1;
      setSelectedConnections(new Map());
      setEligibleConnections((current) => current.filter((person) => !userIds.includes(person.userId)));
    } catch (error) {
      if (scope !== peopleMutationScopeRef.current) return;
      toast.error(circleFlowErrorMessage(error, "Could not add them."));
      // Keep valid choices for retry; the full eligibility read below removes
      // connections or capacity that changed while this batch was saving.
    } finally {
      if (scope === peopleMutationScopeRef.current) {
        peopleSubmitInFlightRef.current = false;
        setPeopleSubmitting(false);
      }
    }
    if (scope !== peopleMutationScopeRef.current) return;
    // Roster and eligibility reconcile together, without locking selection or
    // replacing warm candidates with a loading screen during push refreshes.
    void reload();
    void loadEligibleConnections({ page: 1, query: peopleSearch, reconcileSelections: true });
  };

  const cancelMemberInvite = async (inviteId: string) => {
    if (cancelInviteInFlightRef.current) return;
    cancelInviteInFlightRef.current = true;
    setCancellingInviteId(inviteId);
    try {
      await onCancelMemberInvite(inviteId);
      toast.success("Circle invitation cancelled.");
      await loadEligibleConnections();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not cancel the invitation."),
      );
    } finally {
      cancelInviteInFlightRef.current = false;
      setCancellingInviteId(null);
    }
  };

  const generateCode = async (rotate = false) => {
    if (!circle || !canViewInviteCode || (rotate && !canRotateInviteCode)) {
      return;
    }
    try {
      setInviteCode(await onGenerateCode(circle.id, rotate));
      setReplaceCodeConfirmOpen(false);
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not create an invite code."),
      );
    }
  };

  const copyInviteCode = async (code: string) => {
    await onCopyCode(code);
    setCodeCopied(true);
    window.setTimeout(() => setCodeCopied(false), 1600);
  };

  // The rename is written server-side against the shared Circle row, so once it
  // resolves every member reads the new name on their next load. Reflect it
  // locally right away (header, delete/leave copy, "Add people to …") instead of
  // waiting for a refetch.
  const renameCircle = async (): Promise<boolean> => {
    const nextName = normalizeCircleName(circleName);
    if (
      !circle ||
      renameInFlightRef.current ||
      !canSaveCircleName ||
      nextName.length < 1 ||
      nextName === normalizeCircleName(circle.name)
    )
      return false;
    const requestId = ++renameRequestRef.current;
    renameInFlightRef.current = true;
    setSavingName(true);
    try {
      const updated = await onRename(circle.id, nextName);
      if (requestId !== renameRequestRef.current) return false;
      overviewNameRevisionRef.current += 1;
      setCircle(updated);
      setCircleName(updated.name);
      setRenameSheetOpen(false);
      return true;
    } catch (error) {
      if (requestId !== renameRequestRef.current) return false;
      toast.error(
        circleFlowErrorMessage(error, "Could not rename this Circle."),
      );
      return false;
    } finally {
      if (requestId === renameRequestRef.current) {
        renameInFlightRef.current = false;
        setSavingName(false);
      }
    }
  };

  const removeMember = async (memberUserId: string) => {
    if (!circle) return;
    try {
      await onRemoveMember(circle.id, memberUserId);
      await reload();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not remove this member."),
      );
    }
  };

  const leaveCircle = async () => {
    if (!circle) return;
    try {
      await onLeave(circle.id);
      onBack();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not leave this Circle."),
      );
    }
  };

  const deleteCircle = async () => {
    if (!circle) return;
    try {
      await onDelete(circle.id);
      onBack();
    } catch (error) {
      toast.error(
        circleFlowErrorMessage(error, "Could not delete this Circle."),
      );
    }
  };

  return (
    // `space-y-5`, and every section below owns its own internal rhythm. The
    // screen used to pair a 24px stack gap with `SettingsGroup`'s own 28px
    // heading margin, so the one gap on the page that mattered least -- the
    // one above "Members" -- was also the largest.
    <Tabs value={hasChat ? detailView : "members"} onValueChange={changeDetailView} className="gap-5" data-profile-type-scale="circles" data-testid="one-location-circle-detail-flow">
      {!circle ? (
        <>
          <TaskFlowHeader title={summary?.name ?? "Circle"} description={summary ? circleDetailMemberCountLabel(summary.memberCount) : "Getting members ready…"} />
          {!loadError ? <CircleMembersLoading /> : null}
        </>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          // Wash and hairline move onto the destructive family; the message
          // itself keeps `text-destructive`, which is the dark red this size
          // needs. The flat --app-destructive is the glyph tone and measures
          // ~3.5:1 here, under the 4.5:1 a 14px sentence requires.
          className="rounded-2xl border border-[color:var(--app-destructive-border)] bg-[color:var(--app-destructive-tint)] p-4 text-sm text-destructive"
        >
          {loadError}
          <Button
            type="button"
            variant="ghost"
            size="compact"
            onClick={() => void reload()}
            className="ml-2"
          >
            Retry
          </Button>
        </div>
      ) : null}

      {circle ? (
        <>
          <div className={cn(CIRCLE_DETAIL_HEADER_CLASSNAME, hasChat && "items-center gap-3")}>
            {hasChat ? <CirclePhotoEditor key={`${currentUserId}:${circle.id}`} circleId={circle.id} photoUrl={circle.photoUrl ?? null}
              onOpenChange={setPhotoSheetOpen}
              canEdit={Boolean(isOwner && onPhotoUpdate)} onUpdate={onPhotoUpdate ? async (photoUrl) => {
                const updated = await onPhotoUpdate(circle.id, photoUrl);
                setCircle((current) => current?.id === updated.id ? { ...current, photoUrl: updated.photoUrl } : current);
              } : undefined} /> : null}
            <div className={cn(CIRCLE_DETAIL_HEADER_COPY_CLASSNAME, hasChat && "[&_h1]:text-xl [&_h1]:leading-7 [&_p]:text-sm")}>
              <TaskFlowHeader
                title={circle.name}
                description={hasChat ? `${visibleMemberCount} ${visibleMemberCount === 1 ? "member" : "members"}` : visibleMemberSummary}
              />
            </div>
            {isOwner && circle.systemKind !== "trusted" ? (
              <Button
                type="button"
                variant="ghost"
                size="compact"
                onClick={() => {
                  setCircleName(circle.name);
                  setRenameSheetOpen(true);
                  window.setTimeout(() => nameInputRef.current?.focus(), 80);
                }}
                className="text-[color:var(--app-accent)] hover:bg-[color:var(--app-neutral-fill)] hover:text-[color:var(--app-accent-hover)]"
              >
                Edit
              </Button>
            ) : null}
          </div>

          {hasChat ? <>
            <TabsList variant="line" aria-label="Circle views" className="min-h-11 w-fit justify-start border-b border-border/70">
              <TabsTrigger value="chat" disabled={memberSetup && needsFirstMember && !entryChatIntentRef.current} className="min-h-11 min-w-24 flex-none after:!bottom-0 data-[state=active]:!text-[color:var(--app-accent)] after:bg-[color:var(--app-accent)]">Chat</TabsTrigger>
              <TabsTrigger value="members" className="min-h-11 min-w-24 flex-none after:!bottom-0 data-[state=active]:!text-[color:var(--app-accent)] after:bg-[color:var(--app-accent)]">Members</TabsTrigger>
            </TabsList>
            <TabsContent value="chat" forceMount hidden={detailView !== "chat"} className="space-y-2">
              {renderChat?.(circle, { active: detailView === "chat", readingBlocked: photoSheetOpen || renameSheetOpen || inviteCodeSheetOpen || peopleSheetOpen || replaceCodeConfirmOpen })}
              <button type="button" onClick={() => setDetailView("members")} className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-ring hover:bg-muted/40 sm:px-5" aria-label="View circle members">
                <span aria-hidden="true" className="flex shrink-0 -space-x-2">
                  {orbitMembers.slice(0, 4).map((member) => <ConnectionPersonAvatar key={member.userId} photoUrl={member.photoUrl} label={connectPersonName(member)} size="comfortable" className="!size-8 ring-2 ring-card" />)}
                  {visibleMemberCount > 4 ? <span className="flex size-8 items-center justify-center rounded-full bg-muted text-xs ring-2 ring-card">+{visibleMemberCount - 4}</span> : null}
                </span>
                <span className="min-w-0 flex-1 text-left text-muted-foreground">{visibleMemberCount} {visibleMemberCount === 1 ? "member" : "members"}</span>
                <span className="shrink-0 font-medium text-[color:var(--app-accent)]">View members</span>
              </button>
            </TabsContent>
          </> : null}
          <TabsContent value="members" forceMount hidden={hasChat && detailView !== "members"} className="space-y-5">
          {livingCircleExperience && canInviteMembers && !circle.isSystem && circle.systemKind == null && memberSetup && !needsFirstMember ? (
            <div data-testid="circle-member-setup" className="space-y-2" aria-live="polite">
              <h2 className="ui-text-card-title">Your Circle is ready</h2>
              <p data-profile-role="description" className={MUTED_TEXT}>
                You've added your first member. Add more people below or start chatting.
              </p>
              {!needsFirstMember && hasChat ? (
                <Button type="button" size="prominent" onClick={() => changeDetailView("chat")} className="w-full sm:w-auto">
                  Open chat
                </Button>
              ) : null}
            </div>
          ) : null}
          {livingCircleExperience ? (
            <Sheet modal open={peopleSheetOpen} onOpenChange={open => {
              if (peopleSubmitInFlightRef.current) return;
              if (open) openPeopleSheet();
              else { setPeopleSheetOpen(false); peopleRequestRef.current += 1; setPeopleSearch(""); setSelectedConnections(new Map()); }
            }}>
              <AdaptiveSheetContent dragDismiss={false} className={taskSurfaceStyles.people}>
                <SheetHeader><SheetTitle>Add people</SheetTitle><SheetDescription>Select connections to add to {circle.name}.</SheetDescription></SheetHeader>
            <LivingCirclePanel
              key={circle.id}
              focusOnAdding
              circleName={circle.name}
              members={orbitMembers}
              memberCount={visibleMemberCount}
              groupPhotoUrl={hasChat ? circle.photoUrl ?? null : undefined}
              showGroupIdentity={hasChat}
              canInvite={canInviteMembers}
              candidates={eligibleConnections}
              availableCount={peopleTotalCount}
              remainingCapacity={remainingCapacity}
              loading={peopleLoading}
              error={peopleLoadError}
              selectedUserIds={new Set(selectedConnections.keys())}
              selectedPeople={[...selectedConnections.values()]}
              submitting={peopleSubmitting}
              onAdd={toggleInlineConnection}
              onSubmit={() => void addInlineConnections()}
              onRemove={isOwner ? (userId) => void removeMember(userId) : undefined}
              searchQuery={peopleSearch}
              onSearchChange={setPeopleSearch}
              hasMore={peopleHasMore}
              loadingMore={peopleLoadingMore}
              onLoadMore={() => void loadEligibleConnections({ page: peoplePage + 1, append: true, query: peopleSearch })}
              onRetry={() => void loadEligibleConnections({ page: 1, query: peopleSearch })}
            />
              </AdaptiveSheetContent>
            </Sheet>
          ) : null}

          {isOwner && circle.systemKind !== "trusted" ? (
            <Sheet
              modal
              open={renameSheetOpen}
              onOpenChange={(open) => {
                if (renameInFlightRef.current) return;
                setRenameSheetOpen(open);
                if (!open && circle) setCircleName(circle.name);
              }}
            >
              <AdaptiveSheetContent
                contentDragDismiss
                aria-describedby={undefined}
              >
                <SheetHeader>
                  <SheetTitle>Rename Circle</SheetTitle>
                </SheetHeader>
                <TaskSurfaceBody>
                  <label className="block space-y-2">
                    <span data-profile-role="label" className="text-[15px] font-semibold leading-5 text-foreground">
                      Circle name
                    </span>
                    <div className={CIRCLE_NAME_ROW_CLASSNAME}>
                      <input
                        id={CIRCLE_NAME_INPUT_ID}
                        ref={nameInputRef}
                        value={circleName}
                        disabled={savingName}
                        onChange={(event) => {
                          const next = event.target.value;
                          renameDraftRef.current.dirty = normalizeCircleName(next) !== normalizeCircleName(circle.name);
                          setCircleName(next);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void renameCircle();
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            if (!renameInFlightRef.current) {
                              setRenameSheetOpen(false);
                              setCircleName(circle.name);
                            }
                          }
                        }}
                        maxLength={80}
                        autoComplete="off"
                        className={CIRCLE_RENAME_NAME_INPUT_CLASSNAME}
                      />
                    </div>
                  </label>
                  {circleNameDirty && trimmedCircleName.length < 1 ? (
                    <p data-profile-role="description" className="text-sm text-destructive">Enter a name.</p>
                  ) : null}
                </TaskSurfaceBody>
                <TaskSurfaceFooter>
                  <FlowActionGroup
                    separateSecondary={false}
                    className={taskSurfaceStyles.actionGroup}
                    secondary={
                      <Button
                        type="button"
                        variant="ghost"
                        size="compact"
                        disabled={savingName}
                        onClick={() => {
                          setRenameSheetOpen(false);
                          setCircleName(circle.name);
                        }}
                      >
                        Cancel
                      </Button>
                    }
                    primary={
                      <Button
                        type="button"
                        size="compact"
                        disabled={!canSaveCircleName}
                        isLoading={savingName}
                        onClick={() => void renameCircle()}
                        className={BLOCKED_CTA}
                        data-testid="one-location-circle-name-save"
                      >
                        Save
                      </Button>
                    }
                  />
                </TaskSurfaceFooter>
              </AdaptiveSheetContent>
            </Sheet>
          ) : null}

          {canInviteMembers ? (
            <AddPeopleAction
              onClick={openPeopleSheet}
              disabled={busy}
              data-testid="one-location-circle-add-people-row"
            />
          ) : null}

          {canViewInviteCode ? (
            <SettingsGroup
              title="Invite"
              separatorInset
              shellClassName="!rounded-[18px]"
              testId="one-location-circle-invite-card"
            >
              {canViewInviteCode ? (
                <SettingsRow
                  title="Invite code"
                  trailing={inviteCode ? "Ready" : "Create"}
                  chevron
                  onClick={() => {
                    setCodeCopied(false);
                    setInviteCodeSheetOpen(true);
                  }}
                  disabled={busy}
                  testId="one-location-circle-invite-code-row"
                />
              ) : null}
            </SettingsGroup>
          ) : null}

          {canViewInviteCode ? (
            <Sheet
              modal
              open={inviteCodeSheetOpen}
              onOpenChange={(open) => {
                setInviteCodeSheetOpen(open);
                if (!open) {
                  setCodeCopied(false);
                  setReplaceCodeConfirmOpen(false);
                }
              }}
            >
              <AdaptiveSheetContent
                contentDragDismiss
                aria-describedby={undefined}
                onEscapeKeyDown={(event) => {
                  if (replaceCodeConfirmOpen) event.preventDefault();
                }}
                onFocusOutside={(event) => {
                  if (replaceCodeConfirmOpen) event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (replaceCodeConfirmOpen) event.preventDefault();
                }}
              >
                <SheetHeader>
                  <SheetTitle>Invite code</SheetTitle>
                  {!inviteCode && !inviteCodeNeedsOwnerRotation ? (
                    <SheetDescription>
                      Create a code to invite someone to this Circle.
                    </SheetDescription>
                  ) : null}
                </SheetHeader>
                {inviteCode ? (
                  <Fragment>
                  <TaskSurfaceBody className="space-y-4">
                    <div className="rounded-2xl bg-[color:var(--app-neutral-fill)] p-5 text-center">
                      <p data-profile-role="name" className="break-all font-mono text-2xl font-bold tracking-[0.12em] text-foreground">
                        {inviteCode.code}
                      </p>
                      <p data-profile-role="description" className={cn(MUTED_TEXT, "mt-3")}>
                        Joining does not share location.
                      </p>
                    </div>
                  </TaskSurfaceBody>
                  <TaskSurfaceFooter>
                    <FlowActionGroup
                      separateSecondary={false}
                      className={taskSurfaceStyles.actionGroup}
                      secondary={
                        <Button
                          type="button"
                          variant="outline"
                          size="compact"
                          disabled={busy}
                          onClick={() => void copyInviteCode(inviteCode.code)}
                        >
                          <Copy className="mr-2 h-4 w-4" />
                          {codeCopied ? "Copied" : "Copy code"}
                        </Button>
                      }
                      primary={
                        <Button
                          type="button"
                          size="compact"
                          disabled={busy}
                          onClick={() =>
                            void onShareCode(circle, inviteCode.code)
                          }
                        >
                          <Share2 className="mr-2 h-4 w-4" />
                          Share invite
                        </Button>
                      }
                      tertiary={
                        canRotateInviteCode ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="standard"
                            disabled={busy}
                            onClick={() => setReplaceCodeConfirmOpen(true)}
                          >
                            Replace code
                          </Button>
                        ) : undefined
                      }
                    />
                  </TaskSurfaceFooter>
                  </Fragment>
                ) : inviteCodeNeedsOwnerRotation && !canRotateInviteCode ? (
                  <TaskSurfaceBody>
                    <p data-profile-role="name" className="text-[17px] font-semibold leading-[22px] text-foreground">
                      Invite code unavailable
                    </p>
                    <p data-profile-role="description" className={cn(MUTED_TEXT, "mt-1")}>
                      Ask the Circle owner for a new code.
                    </p>
                  </TaskSurfaceBody>
                ) : (
                  <TaskSurfaceFooter>
                    <FlowActionGroup
                      separateSecondary={false}
                      className={taskSurfaceStyles.actionGroup}
                      secondary={
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            size="compact"
                            className="w-full justify-center"
                            onClick={() => setInviteCodeSheetOpen(false)}
                          >
                            Cancel
                          </Button>
                        </div>
                      }
                      primary={
                        <div>
                          <Button
                            type="button"
                            size="compact"
                            className="w-full justify-center"
                            disabled={busy}
                            isLoading={busy}
                            onClick={() =>
                              void generateCode(inviteCodeNeedsOwnerRotation)
                            }
                          >
                            Create code
                          </Button>
                        </div>
                      }
                    />
                  </TaskSurfaceFooter>
                )}
              </AdaptiveSheetContent>
            </Sheet>
          ) : null}

          {canViewInviteCode && canRotateInviteCode ? (
            <AlertDialog
              open={replaceCodeConfirmOpen}
              onOpenChange={setReplaceCodeConfirmOpen}
            >
              <TaskAlertDialogContent
                size="sm"
                overlayClassName="z-[713]"
                className="z-[714]"
              >
                <AlertDialogHeader>
                  <AlertDialogTitle>Replace invite code?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The current code will stop working.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    disabled={busy}
                    onClick={() => void generateCode(true)}
                  >
                    Replace code
                  </AlertDialogAction>
                </AlertDialogFooter>
              </TaskAlertDialogContent>
            </AlertDialog>
          ) : null}

          {!livingCircleExperience ? (
            <Sheet
            modal
            open={peopleSheetOpen}
            onOpenChange={(open) => {
              if (open && !canInviteMembers) return;
              setPeopleSheetOpen(open);
              if (!open) {
                peopleRequestRef.current += 1;
                setPeopleSearch("");
                setSelectedConnections(new Map());
                if (livingCircleExperience) {
                  void loadEligibleConnections({ page: 1, query: "" });
                }
              }
            }}
          >
            <AdaptiveSheetContent size="lg" dragDismiss={false} className={taskSurfaceStyles.people}
            >
              <SheetHeader>
                <SheetTitle>Add people</SheetTitle>
                <SheetDescription
                  aria-live={isSmsCircle ? "polite" : undefined}
                  data-testid={isSmsCircle ? "one-location-sms-circle-capacity" : undefined}
                >
                  {isSmsCircle
                    ? smsCircleCapacityDescription(
                        remainingCapacity,
                        peopleLoading,
                        peopleLoadError,
                      )
                    : "Choose connections."}
                </SheetDescription>
              </SheetHeader>

              <div className="contents">
                <TaskSurfaceToolbar><SheetSearch value={peopleSearch} onValueChange={setPeopleSearch} placeholder="Search people" /></TaskSurfaceToolbar>

                <TaskSurfaceBody>
                  {peopleLoading ? (
                    <div className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      Loading connections…
                    </div>
                  ) : peopleLoadError ? (
                    <div className="space-y-3 rounded-2xl bg-muted/45 p-4">
                      <p data-profile-role="description" className="text-sm text-muted-foreground">
                        {peopleLoadError}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="standard"
                        onClick={() => void loadEligibleConnections()}
                      >
                        Retry
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {remainingCapacity > 0 &&
                      filteredEligibleConnections.length ? (
                        <SettingsGroup
                          title="Your connections"
                          headingClassName={
                            CIRCLE_SHEET_FIRST_GROUP_HEADING_CLASSNAME
                          }
                          description={
                            isSmsCircle
                              ? undefined
                              : remainingCapacity > CIRCLE_INVITE_BATCH_LIMIT
                              ? `Add up to ${CIRCLE_INVITE_BATCH_LIMIT} people at a time. ${peopleTotalCount} available; ${remainingCapacity} Circle slots remain.`
                              : remainingCapacity === 1
                                ? "You can add 1 more person right now."
                                : `You can add ${remainingCapacity} more people right now. ${peopleTotalCount} available.`
                          }
                          testId="one-location-circle-eligible-connections"
                        >
                          {filteredEligibleConnections.map((connection) => {
                            const selected = selectedConnections.has(
                              connection.userId,
                            );
                            const selectionAtCapacity =
                              selectedConnections.size >= selectionLimit;

                            return (
                              <CirclePersonSelectionRow
                                key={connection.userId}
                                person={connection}
                                selected={selected}
                                disabled={!selected && selectionAtCapacity}
                                onToggle={() =>
                                  setSelectedConnections((current) => {
                                    const next = new Map(current);
                                    if (next.has(connection.userId)) {
                                      next.delete(connection.userId);
                                    } else if (next.size < selectionLimit) {
                                      next.set(connection.userId, connection);
                                    }
                                    return next;
                                  })
                                }
                                testId={`one-location-circle-eligible-${connection.userId}`}
                              />
                            );
                          })}
                        </SettingsGroup>
                      ) : (
                        <EmptyState
                          title={
                            remainingCapacity === 0
                              ? "No room left in this Circle"
                              : peopleSearch.trim()
                                ? "No matching connections"
                                : "No connections to add"
                          }
                          description={
                            remainingCapacity === 0
                              ? "Circle is full."
                              : peopleSearch.trim()
                                ? undefined
                                : undefined
                          }
                          // A sentence pointing at Connect, shown inside a
                          // sheet that covers Connect, with nothing to press.
                          // A first-run person reaches this two taps after
                          // being told "invite people you're connected to",
                          // having none.
                          action={
                            remainingCapacity !== 0 && !peopleSearch.trim() ? (
                              <SheetClose asChild>
                                <Link
                                  href={`${ROUTES.CONNECT}?tab=all`}
                                  className={cn(
                                    buttonVariants({
                                      variant: "outline",
                                      size: "compact",
                                    }),
                                  )}
                                >
                                  Find people
                                </Link>
                              </SheetClose>
                            ) : undefined
                          }
                        />
                      )}

                      {peopleHasMore && !peopleLoading ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="standard"
                          disabled={peopleLoadingMore}
                          isLoading={peopleLoadingMore}
                          onClick={() =>
                            void loadEligibleConnections({
                              page: peoplePage + 1,
                              append: true,
                            })
                          }
                          className="w-full"
                        >
                          Load more connections
                        </Button>
                      ) : null}

                      {pendingInvites.length ? (
                        <SettingsGroup
                          title="Pending"
                          headingClassName={
                            CIRCLE_SHEET_NEXT_GROUP_HEADING_CLASSNAME
                          }
                        >
                          {pendingInvites.map((invite) => (
                            <SettingsRow
                              key={invite.id}
                              layout="person"
                              leading={
                                <ConnectionPersonAvatar
                                  label={
                                    connectPersonName({ displayName: invite.inviteeDisplayName }, "One connection")
                                  }
                                  photoUrl={invite.inviteePhotoUrl}
                                  size="list"
                                />
                              }
                              title={
                                connectPersonName({ displayName: invite.inviteeDisplayName }, "One connection")
                              }
                              description="Waiting"
                              trailing={
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="compact"
                                  disabled={Boolean(cancellingInviteId)}
                                  isLoading={cancellingInviteId === invite.id}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    void cancelMemberInvite(invite.id);
                                  }}
                                  className="text-destructive hover:text-destructive"
                                >
                                  Cancel
                                </Button>
                              }
                            />
                          ))}
                        </SettingsGroup>
                      ) : null}
                    </div>
                  )}
                </TaskSurfaceBody>

                <TaskSurfaceFooter>
                <SheetCount>{selectedConnections.size} selected</SheetCount>
                <Button
                  type="button"
                  size="compact"
                  disabled={
                    !canInviteMembers ||
                    !selectedConnections.size ||
                    peopleLoading ||
                    peopleSubmitting ||
                    Boolean(cancellingInviteId)
                  }
                  isLoading={peopleSubmitting}
                  onClick={() => void sendMemberInvites()}
                  className={BLOCKED_CTA}
                >
                  {selectedConnections.size
                    ? `Add ${selectedConnections.size} ${
                        selectedConnections.size === 1 ? "person" : "people"
                      }`
                    : "Add people"}
                </Button>
                </TaskSurfaceFooter>
              </div>
            </AdaptiveSheetContent>
            </Sheet>
          ) : null}

          {/* One section, in reading order: what this is, how to narrow it,
              then the list. The search field used to sit ABOVE the "Members"
              heading, so the screen offered a way to filter a list it had not
              introduced yet -- and the heading it belonged to arrived after
              it, under `SettingsGroup`'s own 28px top margin. */}
          <section
            className="space-y-2.5"
            aria-labelledby={CIRCLE_MEMBERS_HEADING_ID}
          >
            {showMemberSearch ? (
              <label className="relative block">
                <span className="sr-only">Search members</span>
                <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                {/* The app's own field, so this search box and Connect's are
                    one control rather than two that resemble each other. */}
                <input
                  value={memberSearch}
                  onChange={(event) => setMemberSearch(event.target.value)}
                  placeholder="Search members"
                  autoComplete="off"
                  className={cn(INPUT_CLASSNAME, "pl-11 pr-3.5")}
                  data-testid="one-location-circle-member-search"
                />
              </label>
            ) : null}
            <div className="flex items-baseline justify-between gap-3 px-1.5">
              <SectionLabel
                as="div"
                compact
                role="heading"
                aria-level={2}
                id={CIRCLE_MEMBERS_HEADING_ID}
              >
                Members
              </SectionLabel>
              {/* The count, not "Members connect through this Circle." -- the
                  nearby Add people action already says how to change membership,
                  and a sentence that repeats it is a line of prose between a
                  heading and the thing it heads.

                  Under an active query it counts what is ON SCREEN. The same
                  "3 people" above a filtered list of one is the heading
                  contradicting the list it heads. */}
              <div className="flex items-center gap-3">
                <TrailingValue>{memberCountLabel}</TrailingValue>
              </div>
            </div>



            {!membersLoaded && loadError ? null : membersLoading && !members.length ? <CircleMembersLoading /> : filteredMembers.length ? (
              <SettingsGroup
                testId="one-location-circle-members"
                // A synced Circle can hold up to 100 members (migration 158).
                // Capping the card's own height and scrolling inside it keeps
                // "Delete circle" and everything below reachable without
                // paging through the whole roster first.
                shellClassName={CIRCLE_MEMBERS_CARD_SHELL_CLASSNAME}
                contentClassName={CIRCLE_MEMBERS_CARD_SCROLL_CLASSNAME}
              >
                {filteredMembers.map((member) => (
                  <CircleMemberRow
                    key={member.userId}
                    member={member}
                    currentUserId={currentUserId}
                    isOwner={Boolean(isOwner)}
                    busy={busy}
                    cancelling={cancellingUserId === member.userId}
                    onCancelRequest={
                      onCancelMemberRequest
                        ? async () => {
                            setCancellingUserId(member.userId);
                            try {
                              await onCancelMemberRequest(
                                circle.id,
                                member.userId,
                              );
                            } finally {
                              setCancellingUserId(null);
                            }
                          }
                        : undefined
                    }
                    onShare={() => onShareWithMember(circle.id, member.userId)}
                    onRemove={async () => {
                      await removeMember(member.userId);
                    }}
                    connecting={connectingUserId === member.userId}
                    onConnect={async () => {
                      if (connectingUserId) return;
                      setConnectingUserId(member.userId);
                      try {
                        await onConnectMember(circle.id, member.userId, {
                          displayName: member.displayName ?? null,
                          photoUrl: member.photoUrl ?? null,
                        });
                      } finally {
                        setConnectingUserId(null);
                      }
                    }}
                  />
                ))}
              </SettingsGroup>
            ) : (
              <div className={CIRCLES_EMPTY_STATE_WRAPPER}>
                <EmptyState
                  title="No members found"
                  description="Try a different name."
                />
              </div>
            )}

            {memberHasMore ? (
              <Button
                type="button"
                variant="outline"
                size="standard"
                disabled={memberLoadingMore}
                isLoading={memberLoadingMore}
                onClick={() => void loadMoreMembers()}
                className="w-full"
                data-testid="one-location-circle-members-load-more"
              >
                Load more members
              </Button>
            ) : null}
          </section>

          {onProceedToSms && hasOtherMember ? (
            <div
              className="flex justify-center"
              data-testid="one-location-proceed-to-sms-row"
            >
              <Button
                type="button"
                onClick={onProceedToSms}
                className={CIRCLE_PROCEED_TO_SMS_CLASSNAME}
                data-testid="one-location-proceed-to-sms"
              >
                Proceed to SMS
              </Button>
            </div>
          ) : null}

          {/* A system Circle (today: SMS Contacts) is provisioned by the product
              and read by SOS, so deleting it would switch emergency alerts off
              with nothing on screen saying so. Every other owner power stays --
              rename, invite, remove. The API and a database trigger refuse the
              delete too; this only keeps the person from being offered
              something that cannot happen. */}
          {canDeleteCircle ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  className={cn(CARD_SURFACE, CIRCLE_DESTRUCTIVE_ACTION)}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete circle
                </Button>
              </AlertDialogTrigger>
              <TaskAlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete “{circle.name}”?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the Circle for everyone. Circle shares will
                    stop. Direct shares stay unchanged.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="h-11 w-full sm:w-auto">
                    Cancel
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void deleteCircle()}
                    className="h-11 w-full sm:w-auto"
                  >
                    Delete Circle
                  </AlertDialogAction>
                </AlertDialogFooter>
              </TaskAlertDialogContent>
            </AlertDialog>
          ) : canLeaveCircle ? (
            <div
              className="flex justify-center"
              data-testid="one-location-leave-circle-row"
            >
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    className={cn(CARD_SURFACE, CIRCLE_LEAVE_ACTION_CLASSNAME)}
                  >
                    <LogOut
                      className="mr-2 h-4 w-4"
                      weight="regular"
                      data-testid="one-location-leave-circle-icon"
                    />
                    Leave circle
                  </Button>
                </AlertDialogTrigger>
                <TaskAlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Leave “{circle.name}”?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Circle shares with you will stop. Direct shares stay
                      unchanged.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel className="h-11 w-full sm:w-auto">
                      Cancel
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void leaveCircle()}
                      className="h-11 w-full sm:w-auto"
                    >
                      Leave Circle
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </TaskAlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}
          </TabsContent>
        </>
      ) : null}
    </Tabs>
  );
}
