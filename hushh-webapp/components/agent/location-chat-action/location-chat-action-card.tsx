import { useId, useState, type MouseEvent, type ReactNode } from "react";
import {
  SurfaceCard,
  SurfaceCardContent,
  SurfaceCardHeader,
} from "@/components/app-ui/surfaces";
import {
  CardTitle,
  FormLabel,
  RowDescription,
  RowLabel,
  StatusText,
} from "@/components/app-ui/typography";
import {
  AlertCircleIcon,
  BroadcastIcon,
  CheckCircleIcon,
  MapPinIcon,
  UserCircleIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import { formatLocationDurationLabel } from "@/lib/one-location/duration-copy";
import { parseTimestamp } from "@/lib/one-location/share-countdown";
import { useArmedAction } from "@/lib/ui/use-armed-action";
import { cn } from "@/lib/utils";

export type LocationChatActionChoice = {
  id: string;
  label: string;
  detail?: string;
};

export type LocationChatActionRecovery = {
  id: string;
  label: string;
  variant?: "primary" | "secondary";
};

type DurationMode = "timed" | "until_stopped";

type LocationChatActionDuration = {
  kind: "duration" | "extension";
  minutes?: number;
  options: readonly number[];
  allowUntilStopped?: boolean;
  defaultMode?: DurationMode;
  currentEndAt?: string | null;
  proposedEndAt?: string | null;
};

type LocationChatActionReview = {
  phase: "review";
  confirmLabel: string;
  dismissLabel?: string;
  confirmTone?: "default" | "destructive";
  choices?: readonly LocationChatActionChoice[];
  choiceLabel?: string;
  choiceId?: string;
  duration?: LocationChatActionDuration;
  currentEndAt?: string | null;
  endAt?: string | null;
  canDecline?: boolean;
};

type LocationChatActionReceipt = {
  phase: "result" | "active";
  status?: string;
  endAt?: string | null;
  untilStopped?: boolean;
  updatedAt?: string | null;
  actions?: readonly LocationChatActionRecovery[];
  canStop?: boolean;
};

export type LocationChatActionModel = {
  title: string;
  description?: string;
  subject?: { label: string; detail?: string };
  mode?: "current" | "live";
  facts?: readonly { label: string; value: string }[];
  error?: string;
} & (LocationChatActionReview | LocationChatActionReceipt | {
  phase: "recovery";
  actions?: readonly LocationChatActionRecovery[];
});

export type LocationChatActionInput = {
  choiceId?: string;
  durationMinutes?: number;
  durationMode?: DurationMode;
};

type ButtonEvent = MouseEvent<HTMLButtonElement>;

type LocationChatActionCardProps = {
  model: LocationChatActionModel;
  busy?: boolean;
  onConfirm?: (input: LocationChatActionInput, event: ButtonEvent) => void;
  onDismiss?: () => void;
  onDecline?: (event: ButtonEvent) => void;
  onRecover?: (actionId: string, event: ButtonEvent) => void;
  onStop?: (event: ButtonEvent) => void;
  /** The caller admits an authorized map before passing it into this card. */
  map?: ReactNode;
};

const ACTIONS_CLASS = "flex flex-wrap justify-end gap-2";
const BUTTON_CLASS = "h-auto min-h-11 max-w-full whitespace-normal py-2 text-center [@media(pointer:coarse)]:min-h-11";
const FACTS_CLASS = "grid grid-cols-[repeat(auto-fit,minmax(min(100%,11rem),1fr))] gap-2";
const MINUTE_MS = 60_000;
const UNTIL_STOPPED = "Until you stop";

function EndTime({ value }: { value: string | null }) {
  const timestamp = parseTimestamp(value);
  if (value === null) return UNTIL_STOPPED;
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return (
    <time dateTime={date.toISOString()}>
      {new Intl.DateTimeFormat(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(date)}
    </time>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <RowDescription as="dt" className="text-muted-foreground">{label}</RowDescription>
      <RowLabel as="dd" className="mt-0.5 [overflow-wrap:anywhere]">{children}</RowLabel>
    </div>
  );
}

function DurationOptions({ duration, value, disabled, onChange }: {
  duration: LocationChatActionDuration;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  const options = duration.options.map((minutes) => ({
    value: String(minutes),
    label: formatLocationDurationLabel(minutes / 60),
  }));
  if (duration.kind === "duration" && duration.allowUntilStopped) {
    options.push({ value: "until_stopped", label: UNTIL_STOPPED });
  }
  return (
    <div className="space-y-2">
      <FormLabel as="p" id={labelId}>{duration.kind === "extension" ? "Extra time" : "Duration"}</FormLabel>
      <RadioGroup
        aria-labelledby={labelId}
        className="flex flex-wrap gap-2"
        disabled={disabled}
        value={value}
        onValueChange={onChange}
      >
        {options.map((option, index) => {
          const id = `${labelId}-${index}`;
          return (
            <div key={option.value} className="relative min-w-0">
              <RadioGroupItem value={option.value} id={id} className="peer sr-only" />
              <label
                htmlFor={id}
                className={cn(
                  "ui-text-compact-button-label flex min-h-11 items-center rounded-full border px-3 text-center",
                  "peer-focus-visible:ring-[3px] peer-focus-visible:ring-[color:var(--app-focus-ring)]",
                  option.value === value
                    ? cn(roleClasses("action").tile, roleClasses("action").border, roleClasses("action").glyph)
                    : "border-[color:var(--app-separator)] hover:bg-muted/60",
                  disabled ? "opacity-60" : "cursor-pointer",
                )}
              >
                {option.label}
              </label>
            </div>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function RecipientOptions({ choices, label = "Choose a person", value, disabled, onChange }: {
  choices: readonly LocationChatActionChoice[];
  label?: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-2">
      <FormLabel as="p" id={labelId}>{label}</FormLabel>
      <RadioGroup
        aria-labelledby={labelId}
        className="gap-2"
        disabled={disabled}
        value={value}
        onValueChange={onChange}
      >
        {choices.map((choice, index) => {
          const id = `${labelId}-${index}`;
          return (
            <label
              key={choice.id}
              htmlFor={id}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-[var(--app-input-radius)] border px-3 py-2",
                "has-focus-visible:ring-[3px] has-focus-visible:ring-[color:var(--app-focus-ring)]",
                choice.id === value
                  ? cn(roleClasses("action").tile, roleClasses("action").border)
                  : "border-[color:var(--app-separator)] hover:bg-muted/60",
                disabled ? "opacity-60" : "cursor-pointer",
              )}
            >
              <RadioGroupItem
                value={choice.id}
                id={id}
                aria-labelledby={`${id}-name`}
                aria-describedby={choice.detail ? `${id}-detail` : undefined}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">
                <RowLabel id={`${id}-name`}>{choice.label}</RowLabel>
                {choice.detail ? (
                  <RowDescription id={`${id}-detail`} className="block text-muted-foreground">{choice.detail}</RowDescription>
                ) : null}
              </span>
            </label>
          );
        })}
      </RadioGroup>
    </div>
  );
}

function DeclineOrStopButton({ label, busy, onClick }: {
  label: string;
  busy: boolean;
  onClick: (event: ButtonEvent) => void;
}) {
  const confirmation = useArmedAction();
  return (
    <Button
      size="compact"
      variant={confirmation.armed ? "destructive" : "plain"}
      className={BUTTON_CLASS}
      disabled={busy}
      aria-label={confirmation.ariaLabel(label)}
      onBlur={confirmation.disarm}
      onClick={(event) => confirmation.activate(() => onClick(event))}
    >
      {confirmation.armed ? `Confirm ${label.toLowerCase()}` : label}
    </Button>
  );
}

function ReviewControls({ model, busy, onConfirm, onDismiss, onDecline }: {
  model: LocationChatActionModel & LocationChatActionReview;
  busy: boolean;
} & Pick<LocationChatActionCardProps, "onConfirm" | "onDismiss" | "onDecline">) {
  const [selectedChoice, setSelectedChoice] = useState<string>();
  const [selectedDuration, setSelectedDuration] = useState<string>();
  const { duration } = model;
  const choiceId = selectedChoice ?? model.choiceId ?? "";
  const defaultDuration = duration?.defaultMode === "until_stopped"
    ? "until_stopped"
    : duration?.minutes !== undefined ? String(duration.minutes) : "";
  const durationValue = selectedDuration ?? defaultDuration;
  const untilStopped = durationValue === "until_stopped";
  const durationMinutes = duration?.options.find((minutes) => String(minutes) === durationValue);
  const validDuration = !duration || (untilStopped
    ? duration.kind === "duration" && !!duration.allowUntilStopped
    : durationMinutes !== undefined && Number.isFinite(durationMinutes) && durationMinutes > 0);
  const hasChoice = !model.choices || model.choices.some((choice) => choice.id === choiceId);
  const currentEndAt = duration?.currentEndAt !== undefined ? duration.currentEndAt : model.currentEndAt;
  const currentTimestamp = parseTimestamp(currentEndAt);
  const nextDate = currentTimestamp !== null && duration?.kind === "extension" && durationMinutes !== undefined
    ? new Date(currentTimestamp + durationMinutes * MINUTE_MS)
    : null;
  const matchingProposal = durationValue === defaultDuration && duration?.proposedEndAt !== undefined;
  const nextEndAt = untilStopped && validDuration
    ? null
    : matchingProposal ? duration.proposedEndAt
      : nextDate && Number.isFinite(nextDate.getTime()) ? nextDate.toISOString()
        : durationValue === defaultDuration ? model.endAt : undefined;
  const showCurrentEnd = currentEndAt === null || currentTimestamp !== null;
  const showNextEnd = nextEndAt === null || parseTimestamp(nextEndAt) !== null;

  return (
    <>
      {model.choices?.length ? (
        <RecipientOptions
          label={model.choiceLabel}
          choices={model.choices}
          value={hasChoice ? choiceId : ""}
          disabled={busy}
          onChange={setSelectedChoice}
        />
      ) : null}
      {duration ? (
        <DurationOptions duration={duration} value={validDuration ? durationValue : ""} disabled={busy} onChange={setSelectedDuration} />
      ) : null}
      {showCurrentEnd || showNextEnd ? (
        <dl className={FACTS_CLASS} aria-live="polite">
          {showCurrentEnd && currentEndAt !== undefined ? (
            <Fact label="Current end"><EndTime value={currentEndAt} /></Fact>
          ) : null}
          {showNextEnd && nextEndAt !== undefined ? (
            <Fact label={showCurrentEnd ? "New end" : "Ends"}><EndTime value={nextEndAt} /></Fact>
          ) : null}
        </dl>
      ) : null}
      {onConfirm || onDismiss || (model.canDecline && onDecline) ? (
        <div className={ACTIONS_CLASS}>
          {onDismiss ? (
            <Button size="compact" variant="ghost" className={BUTTON_CLASS} disabled={busy} onClick={onDismiss}>
              {model.dismissLabel ?? "Not now"}
            </Button>
          ) : null}
          {model.canDecline && onDecline ? (
            <DeclineOrStopButton label="Decline" busy={busy} onClick={onDecline} />
          ) : null}
          {onConfirm ? (
            <Button
              className={BUTTON_CLASS}
              size="standard"
              variant={model.confirmTone}
              disabled={busy || !hasChoice || !validDuration || !!model.error}
              onClick={(event) => onConfirm({
                choiceId: choiceId || undefined,
                durationMinutes: untilStopped ? undefined : durationMinutes,
                durationMode: duration ? (untilStopped ? "until_stopped" : "timed") : undefined,
              }, event)}
            >
              {busy ? "Working…" : model.confirmLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export function LocationChatActionCard({
  model,
  busy = false,
  onConfirm,
  onDismiss,
  onDecline,
  onRecover,
  onStop,
  map,
}: LocationChatActionCardProps) {
  const titleId = useId();
  const isReview = model.phase === "review";
  const isReceipt = model.phase === "result" || model.phase === "active";
  const status = isReceipt ? model.status : undefined;
  const modeText = model.mode === "live" ? "Live location" : model.mode === "current" ? "Current location" : null;
  const modeLabel = modeText && !model.title.toLowerCase().includes(modeText.toLowerCase()) ? modeText : null;
  const iconRole = model.phase === "recovery" ? "warning" : model.phase === "active" ? "success"
    : isReview && model.confirmTone === "destructive" ? "danger" : "action";
  const Icon = model.phase === "recovery" ? AlertCircleIcon
    : model.mode === "live" ? BroadcastIcon
      : model.phase === "result" && !model.mode ? CheckCircleIcon : MapPinIcon;
  const endsAt = isReceipt && (model.untilStopped || parseTimestamp(model.endAt) !== null)
    ? model.untilStopped ? null : model.endAt
    : undefined;
  const updatedAt = isReceipt && parseTimestamp(model.updatedAt) !== null ? model.updatedAt : undefined;
  const actions = isReview ? undefined : model.actions;
  const stop = isReceipt && model.canStop ? onStop : undefined;
  const showActions = !!(actions?.length && onRecover) || !!stop || (!isReview && !!onDismiss);
  const showFacts = !!model.facts?.length || endsAt !== undefined || !!updatedAt;

  return (
    <SurfaceCard
      data-testid="location-chat-action-card"
      data-phase={model.phase}
      role="region"
      aria-labelledby={titleId}
      aria-busy={busy || undefined}
      className="w-full font-[family-name:var(--font-app-body)]"
    >
      <SurfaceCardHeader className="flex items-start gap-3 space-y-0">
        <span className={cn("grid size-10 shrink-0 place-items-center rounded-xl", roleClasses(iconRole).tile, roleClasses(iconRole).glyph)}>
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          {status ? <StatusText as="p" role="status" className="text-muted-foreground">{status}</StatusText> : null}
          <CardTitle as="h3" id={titleId}>{model.title}</CardTitle>
          {model.description ? <RowDescription as="p" className="mt-1 text-muted-foreground">{model.description}</RowDescription> : null}
        </div>
      </SurfaceCardHeader>
      <SurfaceCardContent className="space-y-4 empty:hidden">
        {model.subject || modeLabel ? (
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-t border-[color:var(--app-separator)] pt-3">
            {model.subject ? (
              <div className="flex min-w-0 items-start gap-2 [overflow-wrap:anywhere]">
                <UserCircleIcon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <RowLabel as="p">{model.subject.label}</RowLabel>
                  {model.subject.detail ? <RowDescription as="p" className="text-muted-foreground">{model.subject.detail}</RowDescription> : null}
                </div>
              </div>
            ) : null}
            {modeLabel ? <RowDescription className="text-muted-foreground">{modeLabel}</RowDescription> : null}
          </div>
        ) : null}
        {(isReview || isReceipt) && map ? <div className="min-w-0" data-testid="location-chat-action-map">{map}</div> : null}
        {showFacts ? (
          <dl className={FACTS_CLASS}>
            {model.facts?.map(({ label, value }) => <Fact key={`${label}-${value}`} label={label}>{value}</Fact>)}
            {endsAt !== undefined ? <Fact label="Ends"><EndTime value={endsAt} /></Fact> : null}
            {updatedAt ? <Fact label={model.mode === "current" ? "Captured" : "Last updated"}><EndTime value={updatedAt} /></Fact> : null}
          </dl>
        ) : null}
        {model.error ? <RowDescription as="p" role="alert" className={roleClasses("danger").glyph}>{model.error}</RowDescription> : null}
        {isReview ? (
          <ReviewControls model={model} busy={busy} onConfirm={onConfirm} onDismiss={onDismiss} onDecline={onDecline} />
        ) : null}
        {showActions ? (
          <div className={ACTIONS_CLASS}>
            {onDismiss ? (
              <Button size="compact" variant="ghost" className={BUTTON_CLASS} disabled={busy} onClick={onDismiss}>Dismiss</Button>
            ) : null}
            {stop ? <DeclineOrStopButton label="Stop sharing" busy={busy} onClick={stop} /> : null}
            {onRecover && actions?.map((action) => (
              <Button
                key={action.id}
                size={action.variant === "primary" ? "standard" : "compact"}
                variant={action.variant === "primary" ? "default" : "secondary"}
                className={BUTTON_CLASS}
                disabled={busy}
                onClick={(event) => onRecover(action.id, event)}
              >
                {action.label}
              </Button>
            ))}
          </div>
        ) : null}
      </SurfaceCardContent>
    </SurfaceCard>
  );
}
