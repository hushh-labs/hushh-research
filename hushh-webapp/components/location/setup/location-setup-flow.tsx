"use client";

/**
 * Voice-first Location setup.
 *
 * The steps come from the server (`GET /api/one/location/setup-progress`):
 * intro -> consent -> os_permission -> precision -> recipient_key -> done.
 * On mount the persisted step is read and the flow jumps straight to it, so
 * a reload — or a second device — resumes exactly where the person was.
 * Nothing is kept in browser storage.
 *
 * Every tap CTA calls the SAME PATCH the voice tool calls, and the voice
 * tools' results (`get_location_setup_state`, `accept_location_setup_consent`,
 * `advance_location_setup`) re-read progress so the screen follows the
 * server. The OS permission prompt is requested only after the server holds
 * `consent_accepted_at`; the button is disabled until then.
 *
 * Header contract (.claude/skills/location-header-system): rendered inside
 * the shell, no in-content back arrow, eyebrow "Location", title equals the
 * crumb.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { KeyRound } from "@/components/icons";

import { useAuth } from "@/hooks/use-auth";
import {
  HelperText,
  MediumRowLabel,
  RowDescription,
} from "@/components/app-ui/typography";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  useLocationAccountSettings,
  type LocationPrecision,
} from "@/lib/location/account-settings";
import {
  LOCATION_SHARING_CONSENT_VERSION,
  LocationSetupProgressResource,
  hasAcceptedLocationConsent,
  normalizeLocationSetupProgress,
  useSetupProgress,
  type LocationSetupStep,
} from "@/lib/location/setup-progress";
import {
  useOneLocationStateSnapshot,
  useOsLocationPermission,
  type LocationOsPermission,
} from "@/lib/location/sharing-state";
import { morphyToast } from "@/lib/morphy-ux/morphy";
import { CARD_SURFACE } from "@/lib/morphy-ux/tokens/surfaces";
import { TaskFlowHeader } from "@/lib/morphy-ux/ui/surface-primitives";
import { bootstrapCurrentUserLocationRecipientKey } from "@/lib/one-location/key-bootstrap";
import { LocationBus } from "@/lib/one-location/location-bus";
import { resolveLocationRecoveryGuide } from "@/lib/one-location/location-permission-recovery";
import { isLocationPermissionDeniedError } from "@/lib/one-location/location-readiness";
import { OneLocationService } from "@/lib/one-location/service";
import type { ToolResultPublic } from "@/lib/one-voice/protocol";
import { useVoiceToolEffects } from "@/lib/one-voice/session-store";
import { cn } from "@/lib/utils";
import { useVault } from "@/lib/vault/vault-context";

import { ConsentStep } from "./steps/consent-step";
import { DoneStep } from "./steps/done-step";
import { IntroStep } from "./steps/intro-step";
import { OsPermissionStep } from "./steps/os-permission-step";
import { PeopleStep, type SetupPerson } from "./steps/people-step";
import { PrecisionStep } from "./steps/precision-step";

export type LocationSetupFlowProps = {
  mode: "setup";
  onSetupReadinessChange?: (ready: boolean) => void;
  onSetupComplete?: () => void | Promise<void>;
  onSetupSkip?: () => void | Promise<void>;
};

/** The screens, in order. `people` is a local, optional interstitial. */
type SetupView = LocationSetupStep | "people";

const VIEW_ORDER: SetupView[] = [
  "intro",
  "consent",
  "os_permission",
  "precision",
  "recipient_key",
  "people",
  "done",
];

/** Voice tools whose result moves the setup along. */
const SETUP_TOOLS = new Set<string>([
  "get_location_setup_state",
  "start_location_setup",
  "accept_location_setup_consent",
  "advance_location_setup",
]);

const STEP_COPY: Record<
  SetupView,
  { description: string; progressLabel: string }
> = {
  intro: {
    description: "Share where you are with people you trust.",
    progressLabel: "Before you start",
  },
  consent: {
    description:
      "What sharing means, in plain words, before your device is asked anything.",
    progressLabel: "Step 1 of 5 · Consent",
  },
  os_permission: {
    description: "Your device's permission is separate from sharing in Hussh.",
    progressLabel: "Step 2 of 5 · Device permission",
  },
  precision: {
    description: "How exact a shared position should be.",
    progressLabel: "Step 3 of 5 · Precision",
  },
  recipient_key: {
    description:
      "This device gets its own key so people can send you their position too.",
    progressLabel: "Step 4 of 5 · Device key",
  },
  people: {
    description: "Who could receive a share, once you finish.",
    progressLabel: "Step 5 of 5 · People",
  },
  done: {
    description:
      "One tap turns sharing on. Nothing is shared until you name someone.",
    progressLabel: "Finish",
  },
};

function viewIndex(view: SetupView): number {
  return VIEW_ORDER.indexOf(view);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Progress segments: one per screen after the intro. */
function StepProgress({ view }: { view: SetupView }) {
  const segments = VIEW_ORDER.filter((item) => item !== "intro");
  const current = viewIndex(view);
  return (
    <div className="space-y-1.5" aria-hidden>
      <div className="flex gap-1.5">
        {segments.map((segment) => (
          <span
            key={segment}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors",
              viewIndex(segment) <= current
                ? "bg-[color:var(--app-accent)]"
                : "bg-[color:var(--app-separator)]",
            )}
          />
        ))}
      </div>
      <HelperText>{STEP_COPY[view].progressLabel}</HelperText>
    </div>
  );
}

function RecipientKeyStep({
  busy,
  error,
  onRetry,
}: {
  busy: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="space-y-6" data-testid="location-setup-recipient-key">
      <section className={cn(CARD_SURFACE, "p-4")}>
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[color:var(--app-accent-tint)] text-[color:var(--app-accent)]">
            {busy ? (
              <Spinner className="h-[18px] w-[18px]" />
            ) : (
              <KeyRound className="h-[18px] w-[18px]" aria-hidden />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <MediumRowLabel as="p">
              {busy
                ? "Securing this device…"
                : error
                  ? "This device's key isn't registered yet"
                  : "Device key ready"}
            </MediumRowLabel>
            <RowDescription className="mt-0.5">
              A key pair is created here and only the public half is registered.
              It lets people encrypt a position that only this device can open.
            </RowDescription>
          </div>
        </div>
      </section>
      {error ? (
        <div className="space-y-3">
          <HelperText role="alert">{error}</HelperText>
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={onRetry}
            disabled={busy}
          >
            Try again
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function LocationSetupFlow({
  onSetupReadinessChange,
  onSetupComplete,
  onSetupSkip,
}: LocationSetupFlowProps) {
  const { userId } = useAuth();
  const { vaultOwnerToken, vaultKey } = useVault();
  const uid = userId ?? null;
  const progressState = useSetupProgress();
  const settings = useLocationAccountSettings();
  const permission = useOsLocationPermission();
  const locationState = useOneLocationStateSnapshot();

  const { progress, status, currentStep, refresh, advance } = progressState;
  const consentAccepted = hasAcceptedLocationConsent(progress);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [peopleSeen, setPeopleSeen] = useState(false);
  const [observedDenial, setObservedDenial] = useState(false);
  const [precisionDraft, setPrecisionDraft] =
    useState<LocationPrecision | null>(null);
  const keyAttemptRef = useRef(0);

  // The screen follows the server. `people` is shown once, between the key
  // step and done, and never persists.
  const view: SetupView = useMemo(() => {
    if (
      currentStep === "done" &&
      progress &&
      !progress.completed &&
      !peopleSeen
    )
      return "people";
    return currentStep;
  }, [currentStep, progress, peopleSeen]);

  useEffect(() => {
    if (status === "ready" || status === "error")
      onSetupReadinessChange?.(status === "ready");
  }, [status, onSetupReadinessChange]);

  const run = useCallback(
    async (task: () => Promise<void>, fallback: string) => {
      setBusy(true);
      setError(null);
      try {
        await task();
      } catch (caught) {
        const message = errorMessage(caught, fallback);
        setError(message);
        morphyToast.error(message);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // -- voice: tool results move the step -----------------------------------
  const applyToolResult = useCallback(
    (tool: string | null, result: ToolResultPublic | null) => {
      if (!result) return;
      const refreshKeys = Array.isArray(result.ui_refresh)
        ? result.ui_refresh.map(String)
        : [];
      const relevant =
        (tool && SETUP_TOOLS.has(tool)) ||
        refreshKeys.includes("location_setup");
      if (!relevant) return;
      const payload = result.progress;
      if (uid && payload && typeof payload === "object") {
        // The tool carries the server's own row; show it now, re-read anyway.
        LocationSetupProgressResource.write(
          uid,
          normalizeLocationSetupProgress(payload),
        );
      }
      void refresh();
      if (result.status === "advanced" && result.step === "done")
        void settings.refresh();
    },
    [uid, refresh, settings],
  );

  useVoiceToolEffects({
    onToolResult: (tool, result) => applyToolResult(tool, result),
    onPendingResolved: (_id, resolvedStatus, result) => {
      if (resolvedStatus !== "executed") return;
      applyToolResult(
        null,
        result
          ? {
              ...result,
              ui_refresh: [...(result.ui_refresh ?? []), "location_setup"],
            }
          : null,
      );
    },
  });

  // -- step handlers (each is the same PATCH the voice tool uses) ------------
  const handleStart = useCallback(
    () =>
      run(
        () => advance({ action: "start" }).then(() => undefined),
        "Could not start Location setup.",
      ),
    [advance, run],
  );

  const handleAcceptConsent = useCallback(
    () =>
      run(
        () =>
          advance({
            action: "accept_consent",
            consentVersion: LOCATION_SHARING_CONSENT_VERSION,
          }).then(() => undefined),
        "Could not record your consent.",
      ),
    [advance, run],
  );

  const handleConsentContinue = useCallback(() => {
    // Consent already recorded (a voice acceptance landed first); the server
    // row is ahead of the screen. Re-read so the step moves.
    void refresh();
  }, [refresh]);

  const recordOsPermission = useCallback(
    (state: LocationOsPermission) =>
      advance({
        action: "record_os_permission",
        osPermissionState:
          state === "granted"
            ? "granted"
            : state === "denied" || state === "restricted"
              ? "denied"
              : state === "prompt"
                ? "prompt"
                : "unknown",
      }).then((next) => {
        void settings.refresh();
        return next;
      }),
    [advance, settings],
  );

  const handleRequestOsPermission = useCallback(
    () =>
      run(async () => {
        // Refused client-side without server-side consent, whatever the
        // button state says.
        if (
          !hasAcceptedLocationConsent(
            LocationSetupProgressResource.peek(uid).progress,
          )
        ) {
          throw new Error(
            "Accept the Location consent before the device permission prompt.",
          );
        }
        let state: LocationOsPermission = "unknown";
        try {
          state = (await OneLocationService.requestLocationPermission()).state;
        } catch (caught) {
          if (isLocationPermissionDeniedError(caught)) state = "denied";
          else throw caught;
        }
        LocationBus.invalidate();
        await permission.resync();
        if (state === "granted") {
          await recordOsPermission("granted");
          return;
        }
        // Denied: keep the person on this screen with the recovery guide;
        // the answer is recorded when they choose to continue.
        setObservedDenial(true);
      }, "Could not ask for location permission."),
    [permission, recordOsPermission, run, uid],
  );

  const handleOsContinue = useCallback(
    () =>
      run(
        () => recordOsPermission(permission.os).then(() => undefined),
        "Could not record the device permission.",
      ),
    [permission.os, recordOsPermission, run],
  );

  const handleOpenSettings = useCallback(() => {
    void OneLocationService.openAppSettings().catch(() => undefined);
  }, []);

  const precisionValue: LocationPrecision =
    precisionDraft ??
    progress?.precision ??
    settings.settings?.precision ??
    "precise";

  const handlePrecisionContinue = useCallback(
    () =>
      run(
        () =>
          advance({ action: "set_precision", precision: precisionValue }).then(
            () => {
              void settings.refresh();
            },
          ),
        "Could not save your precision choice.",
      ),
    [advance, precisionValue, run, settings],
  );

  // -- recipient key: automatic, with retry ---------------------------------
  const [keyError, setKeyError] = useState<string | null>(null);
  const registerKey = useCallback(() => {
    if (!uid || !vaultOwnerToken) return;
    const attempt = ++keyAttemptRef.current;
    setKeyError(null);
    void run(async () => {
      await bootstrapCurrentUserLocationRecipientKey({
        userId: uid,
        vaultOwnerToken,
        vaultKey,
      });
      if (keyAttemptRef.current !== attempt) return;
      await advance({ action: "confirm_recipient_key" });
    }, "Could not register this device's key.").then(() => {
      if (keyAttemptRef.current !== attempt) return;
      const progressNow = LocationSetupProgressResource.peek(uid).progress;
      if (
        progressNow &&
        progressNow.step !== "recipient_key" &&
        progressNow.step !== "done"
      ) {
        setKeyError("This device's key could not be registered. Try again.");
      }
    });
  }, [advance, run, uid, vaultKey, vaultOwnerToken]);

  useEffect(() => {
    if (view !== "recipient_key") return;
    // Wait for the precision PATCH that brought us here to settle; the
    // attempt counter keeps this to one automatic run. Retries are explicit.
    if (busy) return;
    if (keyAttemptRef.current > 0) return;
    registerKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, busy]);

  useEffect(() => {
    if (view === "recipient_key" && error && !keyError) setKeyError(error);
  }, [view, error, keyError]);

  // -- finish ----------------------------------------------------------------
  const handleFinish = useCallback(
    () =>
      run(async () => {
        if (!progress?.completed) {
          await advance({ action: "complete" });
          await settings.refresh();
        }
        await onSetupComplete?.();
      }, "Could not finish Location setup."),
    [advance, onSetupComplete, progress?.completed, run, settings],
  );

  const handleSkip = useCallback(
    () =>
      run(async () => {
        await onSetupSkip?.();
      }, "Could not skip Location setup."),
    [onSetupSkip, run],
  );

  const people: SetupPerson[] = useMemo(
    () =>
      (locationState?.recipients ?? [])
        .filter((recipient) => recipient.userId && recipient.displayName)
        .map((recipient) => ({
          userId: recipient.userId,
          displayName: recipient.displayName,
          photoUrl: recipient.photoUrl ?? null,
          canReceiveLocation: Boolean(recipient.canReceiveLocation),
        })),
    [locationState],
  );

  const guide = useMemo(
    () =>
      resolveLocationRecoveryGuide({
        userAgent:
          typeof navigator !== "undefined" ? navigator.userAgent : null,
        isNativeApp: Capacitor.isNativePlatform(),
        nativePlatform: Capacitor.getPlatform(),
      }),
    [],
  );

  const loading = status === "idle" || (status === "loading" && !progress);

  return (
    <section
      className="mx-auto w-full max-w-[640px] space-y-6 pb-[max(20px,env(safe-area-inset-bottom))]"
      data-testid="location-setup-flow"
      data-setup-step={view}
    >
      <TaskFlowHeader
        eyebrow="Location"
        title="Location setup"
        description={STEP_COPY[view].description}
      />

      {loading ? (
        <div
          className="flex min-h-[160px] items-center justify-center"
          role="status"
          aria-live="polite"
        >
          <Spinner className="h-5 w-5" />
          <span className="sr-only">Loading Location setup</span>
        </div>
      ) : status === "error" && !progress ? (
        <div className="space-y-3" role="alert">
          <RowDescription>
            {progressState.error ?? "Could not read Location setup."}
          </RowDescription>
          <Button
            type="button"
            size="lg"
            className="w-full"
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </div>
      ) : (
        <>
          <StepProgress view={view} />
          <div key={view} className="motion-step-enter">
            {view === "intro" ? (
              <IntroStep
                busy={busy}
                onStart={handleStart}
                onSkip={onSetupSkip ? handleSkip : undefined}
              />
            ) : view === "consent" ? (
              <ConsentStep
                busy={busy}
                consentVersion={LOCATION_SHARING_CONSENT_VERSION}
                accepted={consentAccepted}
                onAccept={handleAcceptConsent}
                onContinue={handleConsentContinue}
                onDecline={onSetupSkip ? handleSkip : undefined}
              />
            ) : view === "os_permission" ? (
              <OsPermissionStep
                busy={busy}
                consentAccepted={consentAccepted}
                permission={permission.os}
                precise={permission.osPrecise}
                observedDenial={observedDenial}
                guide={guide}
                onRequest={handleRequestOsPermission}
                onContinue={handleOsContinue}
                onOpenSettings={handleOpenSettings}
              />
            ) : view === "precision" ? (
              <PrecisionStep
                busy={busy}
                value={precisionValue}
                onChange={setPrecisionDraft}
                onContinue={handlePrecisionContinue}
              />
            ) : view === "recipient_key" ? (
              <RecipientKeyStep
                busy={busy}
                error={keyError}
                onRetry={registerKey}
              />
            ) : view === "people" ? (
              <PeopleStep
                busy={busy}
                loading={locationState === null}
                people={people}
                onContinue={() => setPeopleSeen(true)}
              />
            ) : (
              <DoneStep
                busy={busy}
                completed={Boolean(progress?.completed)}
                permission={permission.os}
                sharingState={settings.settings?.sharing_state ?? "unset"}
                precision={
                  progress?.precision ??
                  settings.settings?.precision ??
                  "precise"
                }
                onFinish={handleFinish}
              />
            )}
          </div>
          {error && view !== "recipient_key" ? (
            <HelperText
              role="alert"
              className="text-[color:var(--app-destructive)]"
            >
              {error}
            </HelperText>
          ) : null}
        </>
      )}
    </section>
  );
}
