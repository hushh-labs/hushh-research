"use client";

import { useEffect, useRef, useState } from "react";

import { GoogleCloudLogo } from "@/components/brand/google-cloud-logo";
import { MicrosoftAzureLogo } from "@/components/brand/microsoft-azure-logo";
import { ArrowRight, CheckIcon } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  isValidatedAuthSessionOwnerCurrent,
  snapshotValidatedAuthSessionOwner,
} from "@/lib/auth/session-owner";
import { dispatchFeedStateChanged } from "@/lib/feed/feed-events";
import { Button, morphyToast } from "@/lib/morphy-ux/morphy";
import { useBackLayer } from "@/lib/navigation/back-layers";
import { ROUTES } from "@/lib/navigation/routes";
import {
  HOSTED_POD_PROVIDER_LABELS,
  hostedPodDisplayLabel,
  hostedPodProvider,
  isHostedAzureMigrationAvailable,
  ownerCloudProvider,
  podCloudProvider,
  type OwnerCloudProvider,
} from "@/lib/one/owner-cloud";
import { ApiService } from "@/lib/services/api-service";
import {
  parseHostedSourceRetirementStatus,
  type HostedAzureCutoverState,
  type HostedAzureMigrationStatus,
  type HostedSourceRetirementItem,
} from "@/lib/services/hosted-pod-migration";
import { cn } from "@/lib/utils";

const MIGRATION_STEPS = [
  "Locking current pod",
  "Claiming warm Azure pod",
  "Copying encrypted memory",
  "Opening direct access",
] as const;

function stepIndexForJobStage(stage: string | null | undefined, busy: boolean): number {
  const normalized = (stage ?? "").trim().toLowerCase();
  if (normalized.includes("switch") || normalized.includes("direct") || normalized.includes("finish")) {
    return 3;
  }
  if (normalized.includes("export") || normalized.includes("import") || normalized.includes("verify")) {
    return 2;
  }
  if (normalized.includes("provision") || normalized.includes("claim") || normalized.includes("key")) {
    return 1;
  }
  return busy ? 1 : 0;
}

function sourceSummary(mode: string, target: unknown, project?: string | null) {
  const provider = podCloudProvider(target);
  if (mode === "hussh_pods" && provider === "gcp") {
    return {
      provider: "gcp" as OwnerCloudProvider,
      title: "Hussh Pods · Google Cloud",
      detail: project || "Current managed pod",
    };
  }
  if (provider === "azure") {
    return {
      provider: "azure" as OwnerCloudProvider,
      title: "Your Azure",
      detail: project || "Current subscription",
    };
  }
  return {
    provider: "gcp" as OwnerCloudProvider,
    title: "Your Google Cloud",
    detail: project || "Current project",
  };
}

export function PodCloudProviderMark({
  provider,
  className,
}: {
  provider: OwnerCloudProvider;
  className?: string;
}) {
  if (provider === "azure") {
    return <MicrosoftAzureLogo decorative className={cn("h-4 w-4 shrink-0", className)} />;
  }
  return <GoogleCloudLogo decorative className={cn("h-4 w-auto shrink-0", className)} />;
}

export function PodCloudBadge({
  provider,
  label,
  testId,
}: {
  provider: OwnerCloudProvider;
  label?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-[var(--app-card-surface-default)] px-2.5 py-1 text-xs font-medium text-foreground"
    >
      <PodCloudProviderMark provider={provider} className="h-3.5 w-3.5" />
      <span>{label ?? HOSTED_POD_PROVIDER_LABELS[provider]}</span>
    </span>
  );
}

export function HostedPodDualCloudMarks({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <GoogleCloudLogo decorative className="h-4 w-auto" />
      <MicrosoftAzureLogo decorative className="h-4 w-4" />
    </span>
  );
}

function formatSafetyWindowDate(iso: string | null | undefined): string {
  if (!iso) return "14 days";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "14 days";
  try {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
      new Date(parsed),
    );
  } catch {
    return "14 days";
  }
}

export function HusshPodsActiveCard({
  deploymentTarget,
  cutover,
  embedded = false,
  dataTestId = "hussh-pods-connected",
}: {
  deploymentTarget?: string | null;
  cutover?: HostedAzureCutoverState | null;
  embedded?: boolean;
  dataTestId?: string;
}) {
  const provider = hostedPodProvider(deploymentTarget);
  const title = hostedPodDisplayLabel(deploymentTarget);
  const statusLabel = cutover?.directReady ? "Direct" : "Connected";
  const [retirementItems, setRetirementItems] = useState<HostedSourceRetirementItem[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const confirmBusyRef = useRef(false);

  const canInspectSourceRetirement =
    provider === "azure" &&
    isHostedAzureMigrationAvailable() &&
    typeof ApiService.getHostedSourceRetirementStatus === "function";

  useEffect(() => {
    if (!canInspectSourceRetirement) {
      setRetirementItems([]);
      return;
    }
    const owner = snapshotValidatedAuthSessionOwner();
    const controller = new AbortController();
    const stillCurrent = () =>
      !controller.signal.aborted &&
      (!owner || isValidatedAuthSessionOwnerCurrent(owner));

    void ApiService.getHostedSourceRetirementStatus({ signal: controller.signal })
      .then((res) => {
        if (stillCurrent()) setRetirementItems(res.items);
      })
      .catch(() => {
        // Optional safety-window detail; active card stays healthy without blocking Hosting.
      });

    return () => controller.abort();
  }, [canInspectSourceRetirement, deploymentTarget]);

  const activeGraceItem =
    retirementItems.length > 0 ? retirementItems[retirementItems.length - 1]! : null;
  const activeItemRetired = Boolean(activeGraceItem?.status.startsWith("retired_"));
  const canConfirmRetirement =
    Boolean(activeGraceItem) &&
    !activeGraceItem?.ownerConfirmed &&
    !activeItemRetired &&
    typeof ApiService.confirmHostedSourceRetirement === "function";

  const confirmNewPod = async () => {
    if (!activeGraceItem || confirmBusyRef.current) return;
    if (typeof ApiService.confirmHostedSourceRetirement !== "function") return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isEffectCurrent = () => !owner || isValidatedAuthSessionOwnerCurrent(owner);
    if (!isEffectCurrent()) return;

    setConfirmOpen(false);
    confirmBusyRef.current = true;
    setConfirmBusy(true);

    let toastHandle: ReturnType<typeof morphyToast.promiseText> | undefined;
    try {
      const request = ApiService.confirmHostedSourceRetirement({
        placementId: activeGraceItem.placementId,
        isEffectCurrent,
      });
      toastHandle = morphyToast.promiseText(request, {
        loading: "Saving confirmation…",
        success: "Confirmed. Prior pod will retire after its 14-day window.",
        error: (err) =>
          err instanceof Error && err.message
            ? err.message
            : "Could not save your confirmation right now.",
        isCurrent: isEffectCurrent,
      });
      const updated = parseHostedSourceRetirementStatus(await toastHandle.unwrap());
      if (isEffectCurrent()) {
        setRetirementItems(updated.items);
        dispatchFeedStateChanged();
      }
    } catch {
      // Toast carries actionable failure copy.
    } finally {
      if (!isEffectCurrent()) {
        const toastId = toastHandle?.valueOf();
        if (typeof toastId === "number" || typeof toastId === "string") {
          morphyToast.dismiss(toastId);
        }
      }
      confirmBusyRef.current = false;
      setConfirmBusy(false);
    }
  };

  return (
    <>
      <div
        data-testid={dataTestId}
        data-provider={provider ?? "unknown"}
        className={cn(
          "space-y-3",
          embedded
            ? "p-4"
            : "rounded-2xl border border-[var(--app-border)] bg-[var(--app-card-surface-default)] p-4",
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            {provider ? (
              <span
                aria-hidden="true"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--app-border)] bg-background"
              >
                <PodCloudProviderMark provider={provider} className="h-5 w-5" />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground">{title}</p>
              <p className="text-xs text-[var(--app-text-secondary)]">
                Dedicated private agent managed by Hussh
              </p>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--app-border)] bg-background px-2.5 py-0.5 text-xs font-medium text-foreground">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-[color:var(--app-accent)]"
            />
            {statusLabel}
          </span>
        </div>
        <p className="text-sm text-[var(--app-text-secondary)]">
          {provider === "azure"
            ? "Your agent runs on Microsoft Azure in Hussh’s managed cell. Your prior cloud setup stays untouched during its 14-day safety window."
            : provider === "gcp"
              ? "Your agent runs on Google Cloud in a dedicated pod managed by Hussh."
              : "Your dedicated private agent is active on Hussh Pods."}
        </p>

        {activeGraceItem ? (
          <div
            data-testid="hussh-pods-source-retirement"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-background p-3"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="text-xs font-semibold text-foreground">
                Prior cloud · {activeGraceItem.sourceLabel}
              </p>
              {activeItemRetired ? (
                <p
                  data-testid="hussh-pods-retirement-complete"
                  className="text-xs text-[var(--app-text-secondary)]"
                >
                  14-day safety window complete ·{" "}
                  {activeGraceItem.ownerCloudCleanupReady
                    ? "Hussh access revoked; you may remove the old cloud resources anytime."
                    : "Prior pod retired."}
                </p>
              ) : activeGraceItem.ownerConfirmed ? (
                <p
                  data-testid="hussh-pods-retirement-confirmed"
                  className="text-xs text-[var(--app-text-secondary)]"
                >
                  Confirmed · Prior pod retires after{" "}
                  {formatSafetyWindowDate(activeGraceItem.graceReapAfter)}
                </p>
              ) : (
                <p className="text-xs text-[var(--app-text-secondary)]">
                  {activeGraceItem.graceExpired
                    ? "14-day safety window complete · Confirm comfort on Azure to retire the prior pod."
                    : `${activeGraceItem.daysRemaining}d left in 14-day safety window`}
                </p>
              )}
            </div>
            {canConfirmRetirement ? (
              <Button
                type="button"
                variant="muted"
                disabled={confirmBusy}
                onClick={() => setConfirmOpen(true)}
                className="min-h-11 shrink-0"
                data-testid="hussh-pods-confirm-retirement-trigger"
              >
                {confirmBusy ? "Confirming…" : "Confirm new pod"}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {activeGraceItem ? (
        <AlertDialog open={confirmOpen} onOpenChange={(open) => !confirmBusy && setConfirmOpen(open)}>
          <AlertDialogContent size="default">
            <AlertDialogHeader>
              <AlertDialogTitle>Confirm your new Azure pod?</AlertDialogTitle>
              <AlertDialogDescription>
                Your prior setup ({activeGraceItem.sourceLabel}) stays untouched until its 14-day
                safety window ends on {formatSafetyWindowDate(activeGraceItem.graceReapAfter)}. After
                that date, your confirmation allows automated retirement.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <p className="text-sm text-[var(--app-text-secondary)]">
              {activeGraceItem.sourceKind === "byoc"
                ? "For your own cloud, Hussh only revokes its own observer access — never deleting your resource group or vault."
                : "Your prior managed pod will be retired only after the 14-day window expires."}
            </p>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={confirmBusy}>Not yet</AlertDialogCancel>
              <AlertDialogAction
                disabled={confirmBusy}
                onClick={() => void confirmNewPod()}
                data-testid="hussh-pods-confirm-retirement-action"
              >
                {confirmBusy ? "Saving…" : "Confirm"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </>
  );
}

export function HusshPodsMigrationCard({
  sourceMode,
  sourceTarget,
  sourceProject,
  onMigrated,
  owningRoute = ROUTES.PROFILE_HOSTING,
  embedded = false,
  subtleAction = false,
}: {
  sourceMode: string;
  sourceTarget?: string | null;
  sourceProject?: string | null;
  onMigrated?: () => void;
  owningRoute?: Parameters<typeof useBackLayer>[0];
  embedded?: boolean;
  subtleAction?: boolean;
}) {
  const [status, setStatus] = useState<HostedAzureMigrationStatus | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const busyRef = useRef(false);

  const canReadMigrationStatus =
    typeof ApiService.getHostedAzureMigrationStatus === "function";

  useEffect(() => {
    if (!canReadMigrationStatus) return;
    const owner = snapshotValidatedAuthSessionOwner();
    const controller = new AbortController();
    const stillCurrent = () =>
      !controller.signal.aborted &&
      (!owner || isValidatedAuthSessionOwnerCurrent(owner));

    void ApiService.getHostedAzureMigrationStatus({ signal: controller.signal })
      .then((next) => {
        if (stillCurrent()) setStatus(next);
      })
      .catch(() => {
        // Optional readiness hint; fallback copy stays honest without failing the card.
      });

    return () => controller.abort();
  }, [canReadMigrationStatus, sourceMode, sourceTarget]);

  useBackLayer(owningRoute, busy ? 2 : 0, () => true);

  const source = sourceSummary(sourceMode, sourceTarget, sourceProject);
  const warmSlots = status ? status.cellPool.totalAzureWarmSlots : null;
  const isJobRunning = busy || status?.job?.status === "running";
  const poolEmpty = warmSlots !== null && warmSlots <= 0;
  const activeStep = stepIndexForJobStage(status?.job?.stage, busy);
  const readinessLabel =
    warmSlots === null
      ? "~20s switch"
      : warmSlots > 0
        ? `~20s · ${warmSlots} ${warmSlots === 1 ? "warm pod" : "warm pods"} ready`
        : "Replenishing warm pods";

  const startMigration = async () => {
    if (busyRef.current || typeof ApiService.migrateToHostedAzure !== "function") return;
    const owner = snapshotValidatedAuthSessionOwner();
    const isEffectCurrent = () =>
      !owner || isValidatedAuthSessionOwnerCurrent(owner);
    if (!isEffectCurrent()) return;

    setConfirmOpen(false);
    setErrorMessage(null);
    busyRef.current = true;
    setBusy(true);

    let toastHandle: ReturnType<typeof morphyToast.promiseText> | undefined;
    try {
      const request = ApiService.migrateToHostedAzure({ isEffectCurrent });
      toastHandle = morphyToast.promiseText(request, {
        loading: "Moving your agent to Hussh Pods · Azure…",
        success: "Agent moved to Hussh Pods · Microsoft Azure.",
        error: (err) =>
          err instanceof Error && err.message
            ? err.message
            : "Could not move your pod right now. Your current setup is unchanged.",
        isCurrent: isEffectCurrent,
      });
      await toastHandle.unwrap();
      if (isEffectCurrent()) {
        dispatchFeedStateChanged();
        onMigrated?.();
      }
    } catch (err) {
      if (isEffectCurrent()) {
        setErrorMessage(
          err instanceof Error && err.message
            ? err.message
            : "Could not move your pod right now. Your current setup is unchanged.",
        );
      }
    } finally {
      if (!isEffectCurrent()) {
        const toastId = toastHandle?.valueOf();
        if (typeof toastId === "number" || typeof toastId === "string") {
          morphyToast.dismiss(toastId);
        }
      }
      busyRef.current = false;
      setBusy(false);
    }
  };

  const triggerDisabled =
    isJobRunning ||
    poolEmpty ||
    typeof ApiService.migrateToHostedAzure !== "function";

  return (
    <>
      <div
        data-testid="hussh-pods-migration-card"
        className={cn(
          "space-y-4",
          embedded
            ? "p-4"
            : "rounded-2xl border border-[var(--app-border)] bg-[var(--app-card-surface-default)] p-4",
        )}
      >
        <div
          data-testid="hussh-pods-migration-route"
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center"
        >
          <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[var(--app-border)] bg-background p-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-[var(--app-card-surface-default)]"
            >
              <PodCloudProviderMark provider={source.provider} className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--app-text-secondary)]">
                Current
              </p>
              <p className="truncate text-sm font-semibold text-foreground">{source.title}</p>
              <p className="truncate text-xs text-[var(--app-text-secondary)]">{source.detail}</p>
            </div>
          </div>

          <div className="flex flex-row items-center justify-center gap-2 px-1 sm:flex-col sm:gap-1">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--app-border)] bg-background text-[var(--app-text-secondary)]"
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </span>
            <span
              data-testid="hussh-pods-warm-capacity"
              className="rounded-full border border-[var(--app-border)] bg-background px-2 py-0.5 text-[11px] font-medium text-[var(--app-text-secondary)]"
            >
              {readinessLabel}
            </span>
          </div>

          <div className="flex min-w-0 items-center gap-2.5 rounded-xl border border-[color:var(--app-accent-border)] bg-[color:var(--app-accent-tint)] p-3">
            <span
              aria-hidden="true"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--app-border)] bg-background"
            >
              <MicrosoftAzureLogo decorative className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--app-text-secondary)]">
                Destination
              </p>
              <p className="truncate text-sm font-semibold text-foreground">Hussh Pods</p>
              <p className="truncate text-xs text-[var(--app-text-secondary)]">Microsoft Azure</p>
            </div>
          </div>
        </div>

        <p className="text-sm text-[var(--app-text-secondary)]">
          Move your dedicated agent to a pre-warmed Azure pod managed by Hussh. Your memory stays
          intact, and your current cloud stays untouched for 14 days.
        </p>

        {isJobRunning ? (
          <div
            data-testid="hussh-pods-migration-progress"
            aria-live="polite"
            className="space-y-2 rounded-xl border border-[var(--app-border)] bg-background p-3"
          >
            <p className="text-xs font-semibold text-foreground">Migration in progress</p>
            <ol className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {MIGRATION_STEPS.map((label, index) => {
                const done = index < activeStep;
                const currentStep = index === activeStep;
                return (
                  <li
                    key={label}
                    className={cn(
                      "flex items-center gap-2 text-xs",
                      done || currentStep
                        ? "font-medium text-foreground"
                        : "text-[var(--app-text-secondary)]",
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border",
                        done
                          ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent)] text-[color:var(--app-accent-fg)]"
                          : currentStep
                            ? "border-[color:var(--app-accent)] bg-[color:var(--app-accent-tint)]"
                            : "border-[var(--app-border)]",
                      )}
                    >
                      {done ? <CheckIcon className="h-2.5 w-2.5" weight="bold" /> : null}
                    </span>
                    <span>{label}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : null}

        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive" data-testid="hussh-pods-migrate-error">
            {errorMessage}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            type="button"
            variant={subtleAction ? "blue" : undefined}
            disabled={triggerDisabled}
            onClick={() => setConfirmOpen(true)}
            className="min-h-11"
            data-testid="hussh-pods-migrate-trigger"
          >
            {isJobRunning ? "Moving to Hussh Pods · Azure…" : "Move to Hussh Pods · Azure"}
          </Button>
          {ownerCloudProvider(sourceTarget) === null ? null : (
            <span className="text-xs text-[var(--app-text-secondary)]">
              14-day rollback window kept on your old cloud
            </span>
          )}
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={(open) => !busy && setConfirmOpen(open)}>
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>Move your pod to Hussh Pods · Azure?</AlertDialogTitle>
            <AlertDialogDescription>
              Your agent will move from {source.title} to a dedicated pod on Microsoft Azure managed
              by Hussh.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--app-border)] bg-background p-3">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <PodCloudProviderMark provider={source.provider} className="h-4 w-4" />
              <span className="truncate">{source.title}</span>
            </div>
            <ArrowRight className="h-4 w-4 shrink-0 text-[var(--app-text-secondary)]" aria-hidden="true" />
            <div className="flex items-center gap-2 text-sm font-medium text-foreground">
              <MicrosoftAzureLogo decorative className="h-4 w-4" />
              <span>Hussh Pods · Azure</span>
            </div>
          </div>
          <p className="text-sm text-[var(--app-text-secondary)]">
            Your vault and encrypted memory stay intact. Your previous cloud remains untouched for
            14 days.
          </p>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => void startMigration()}
              data-testid="hussh-pods-migrate-confirm"
            >
              {busy ? "Moving…" : "Move pod"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
