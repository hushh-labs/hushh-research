"use client";

/**
 * Why voice stopped, in full, with the one action that fixes it.
 *
 * A microphone-permission error exposes the OS settings action (native only:
 * the control wires it to NativeOneVoiceInvocation.openCommandCaptureSettings);
 * everything recoverable gets "Try again". No auto-fade — this describes
 * something broken and stays until the person reads it and closes it.
 */

import { AlertTriangle, MicOff, Settings, X } from "@/components/icons";

import { Button } from "@/components/ui/button";
import { roleClasses } from "@/lib/morphy-ux/tokens/semantic-roles";
import type { VoiceError } from "@/lib/one-voice/session-types";
import { cn } from "@/lib/utils";

export type VoiceErrorCardProps = {
  error: VoiceError;
  onRetry?: () => void;
  /** Present only where the app can open the OS microphone settings. */
  onOpenSettings?: () => void;
  onDismiss?: () => void;
  className?: string;
};

const MIC_PERMISSION_CODES = new Set<string>([
  "not_allowed",
  "mic_not_allowed",
  "mic_permission",
  "permission_denied",
]);

/** True for the errors the OS settings screen can fix. */
export function isMicPermissionError(code: string | null | undefined): boolean {
  const value = String(code || "")
    .trim()
    .toLowerCase();
  if (!value) return false;
  if (MIC_PERMISSION_CODES.has(value)) return true;
  return value.includes("permission") || value.includes("not_allowed");
}

const TITLE_BY_CODE: Record<string, string> = {
  not_allowed: "Microphone access is blocked",
  not_found: "No microphone found",
  not_readable: "Microphone is busy",
  not_supported: "Voice isn't supported here",
  worklet_unavailable: "Voice can't run in this browser",
  voice_unavailable: "Voice is unavailable",
  disabled: "Voice is off",
  auth: "Unlock to continue",
  capacity: "Voice is busy",
  replaced: "Voice moved",
  max_duration: "Session time limit",
  protocol: "Voice is unavailable",
};

/** A short title for the card; the message underneath carries the detail. */
export function voiceErrorTitle(error: Pick<VoiceError, "code">): string {
  const code = String(error.code || "").trim();
  if (TITLE_BY_CODE[code]) return TITLE_BY_CODE[code];
  if (isMicPermissionError(code)) return TITLE_BY_CODE.not_allowed!;
  return "Voice couldn't continue";
}

export function VoiceErrorCard({
  error,
  onRetry,
  onOpenSettings,
  onDismiss,
  className,
}: VoiceErrorCardProps) {
  const micPermission = isMicPermissionError(error.code);
  const danger = roleClasses("danger");
  const Icon = micPermission ? MicOff : AlertTriangle;
  const showSettings = micPermission && typeof onOpenSettings === "function";
  const showRetry = typeof onRetry === "function";

  return (
    <div
      role="alert"
      data-testid="one-voice-error-card"
      data-error-code={error.code}
      className={cn(
        "rounded-[var(--app-card-radius-standard,24px)] border bg-[color:var(--app-primary-surface)] p-4 shadow-[var(--app-card-shadow-standard)] dark:shadow-none",
        danger.border,
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
            danger.tile,
            danger.glyph,
          )}
          aria-hidden
        >
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-5 text-[color:var(--app-label)]">
            {voiceErrorTitle(error)}
          </p>
          <p className="mt-0.5 text-[13px] leading-[18px] text-[color:var(--app-secondary-label)]">
            {error.message}
          </p>
        </div>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss"
            data-testid="one-voice-error-dismiss"
            className="-mr-2 -mt-2 flex h-11 w-11 shrink-0 touch-manipulation items-center justify-center rounded-full text-[color:var(--app-secondary-label)] hover:bg-[color:var(--app-neutral-fill)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--app-focus-ring)]"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        ) : null}
      </div>
      {showSettings || showRetry ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {showSettings ? (
            <Button
              type="button"
              size="sm"
              variant="default"
              onClick={onOpenSettings}
              data-testid="one-voice-error-open-settings"
              className="min-h-11 flex-1 px-4"
            >
              <Settings className="h-4 w-4" aria-hidden />
              Open Settings
            </Button>
          ) : null}
          {showRetry ? (
            <Button
              type="button"
              size="sm"
              variant={showSettings ? "secondary" : "default"}
              onClick={onRetry}
              data-testid="one-voice-error-retry"
              className="min-h-11 flex-1 px-4"
            >
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
