type SosHoldProgressProps = {
  variant: "sms" | "composer";
  progress: number;
};

/** One visual sweep for either control; the panel owns timing and send authority. */
export function SosHoldProgress({ variant, progress }: SosHoldProgressProps) {
  const sms = variant === "sms";
  if (!sms && progress <= 0) return null;
  // Start at the top, clockwise. The composer ring follows its existing pill
  // so both the timer and Cancel remain inside the outline without overlap.
  const outline = sms
    ? "M172 4 a168 168 0 1 1 0 336 a168 168 0 1 1 0 -336"
    : "M36 2 H50 a20 20 0 0 1 0 40 H22 a20 20 0 0 1 0 -40 Z";

  return (
    <svg
      viewBox={sms ? "0 0 344 344" : "0 0 72 44"}
      preserveAspectRatio="none"
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      <path
        d={outline}
        fill="none"
        stroke={sms ? "var(--sos-ring-track)" : "currentColor"}
        strokeOpacity={sms ? 1 : 0.25}
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      {progress > 0 ? (
        <path
          data-testid={sms ? "sos-sms-progress" : "sos-send-progress"}
          d={outline}
          fill="none"
          stroke={sms ? "var(--app-destructive)" : "currentColor"}
          strokeWidth={sms ? 5 : 2}
          strokeLinecap="round"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 * (1 - progress)}
          vectorEffect="non-scaling-stroke"
        />
      ) : null}
    </svg>
  );
}
