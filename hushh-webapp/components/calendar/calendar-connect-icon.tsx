import type { CSSProperties } from "react";

export function CalendarConnectIcon({
  className = "size-10 mb-2.5",
  style = { color: "#FF3B30" },
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      aria-hidden="true"
      className={className}
      style={style}
    >
      <rect
        x="8.5"
        y="11.5"
        width="31"
        height="29"
        rx="4.5"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M9.5 20.5h29M16 7.5v8M32 7.5v8"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {[16, 24, 32].flatMap((x) =>
        [27, 35].map((y) => (
          <rect
            key={`${x}-${y}`}
            x={x - 2}
            y={y - 2}
            width="4"
            height="4"
            rx="1"
            fill="currentColor"
          />
        )),
      )}
    </svg>
  );
}
