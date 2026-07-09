"use client";

import { useState } from "react";

export interface BackgroundShareToggleProps {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  requestAlwaysAuthorization: () => Promise<{ background: string }>;
}

/**
 * Opt-in switch for background location sharing. Turning it ON requests iOS
 * "Always" authorization; we only flip enabled when that is granted, otherwise
 * we keep it off and explain why. Turning it OFF is immediate.
 */
export function BackgroundShareToggle({
  enabled,
  onEnabledChange,
  requestAlwaysAuthorization,
}: BackgroundShareToggleProps) {
  const [pending, setPending] = useState(false);
  const [needsAlways, setNeedsAlways] = useState(false);

  const handleToggle = async () => {
    if (enabled) {
      onEnabledChange(false);
      return;
    }
    setPending(true);
    try {
      const state = await requestAlwaysAuthorization();
      if (state.background === "available") {
        setNeedsAlways(false);
        onEnabledChange(true);
      } else {
        setNeedsAlways(true);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={pending}
        onClick={handleToggle}
        className="inline-flex items-center gap-2 text-sm font-medium"
      >
        <span
          className={
            enabled
              ? "h-5 w-9 rounded-full bg-emerald-500"
              : "h-5 w-9 rounded-full bg-muted"
          }
        />
        Keep sharing when the app is closed
      </button>
      {needsAlways ? (
        <p className="text-xs text-amber-600">
          Set location access to “Always” in Settings to keep sharing in the
          background.
        </p>
      ) : null}
    </div>
  );
}
