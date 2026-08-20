"use client";

import { Loader2, MapPinOff } from "lucide-react";
import { useCallback, useMemo } from "react";

import { Button } from "@/components/ui/button";
import { isNative, getPlatform } from "@/lib/capacitor/platform";
import { resolveLocationRecoveryGuide } from "@/lib/one-location/location-permission-recovery";
import { useLocationPermissionHealing } from "@/lib/one-location/use-location-permission-healing";

/**
 * The way out of a blocked location permission.
 *
 * It exists because the previous answer was a toast reading "Allow location
 * permission before sharing" beside an "Open Location Settings" button that
 * resolves `{ opened: false }` in every browser. The one instruction was the
 * one thing the person could not act on, the button did nothing, and the toast
 * was gone within seconds — leaving the Location screen with the word
 * "blocked" on it and no way forward. Someone who did not already know that
 * browsers keep a per-site location switch behind an icon in the address bar
 * had no path at all.
 *
 * Rendered in the neutral surface style rather than as an alert, deliberately:
 * the person has done nothing wrong and this is a state to work through, which
 * is the same reasoning the Nearby drawer's fallback follows.
 *
 * It never claims to be able to ask again, because it cannot. Once a browser
 * has recorded a block, no website may reopen that dialog — a security rule,
 * not a limitation of this app. So the card does the only two useful things
 * left: say precisely where the switch is, and notice the moment it moves.
 */
export function LocationPermissionRecoveryCard({
  blocked,
  busy = false,
  onRetry,
  onOpenSettings,
}: {
  /** An observed refusal, not merely a permission API reporting "denied". */
  blocked: boolean;
  busy?: boolean;
  /** Re-attempt a capture. Also what runs when healing is detected. */
  onRetry: () => void;
  /** Native only. Absent on web, where no settings pane can be opened. */
  onOpenSettings?: () => void;
}) {
  const guide = useMemo(
    () =>
      resolveLocationRecoveryGuide({
        userAgent:
          typeof navigator === "undefined" ? "" : navigator.userAgent,
        isNativeApp: isNative(),
        nativePlatform: getPlatform(),
      }),
    [],
  );

  const handleGranted = useCallback(() => {
    onRetry();
  }, [onRetry]);

  useLocationPermissionHealing({ enabled: blocked, onGranted: handleGranted });

  if (!blocked) return null;

  const canOpenSettings = guide.canOpenSettings && Boolean(onOpenSettings);

  return (
    <div
      className="rounded-2xl border border-border/60 bg-muted/50 p-4"
      role="status"
      data-testid="location-permission-recovery"
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-background text-muted-foreground"
          aria-hidden="true"
        >
          <MapPinOff className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{guide.title}</p>
          <p className="mt-0.5 text-sm leading-5 text-muted-foreground">
            We can&rsquo;t turn this on for you — only you can, and it takes a
            few seconds.
          </p>
          <ol
            className="mt-2.5 list-decimal space-y-1 pl-4 text-sm leading-5 text-muted-foreground"
            data-testid="location-permission-recovery-steps"
          >
            {guide.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onRetry}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Check again
        </Button>
        {canOpenSettings ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={onOpenSettings}
          >
            Open Settings
          </Button>
        ) : null}
      </div>
    </div>
  );
}
