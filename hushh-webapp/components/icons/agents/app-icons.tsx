import { useId, type ReactNode, type SVGProps } from "react";

import { AGENT_APP_ICON_PALETTE } from "@/lib/design/home-icon-palette";

export type AgentAppIconId = keyof typeof AGENT_APP_ICON_PALETTE;

// One 32-unit drawing grid. Filled silhouettes and open counters remain legible
// at the 40px list size; larger launchers use exactly the same vector artwork.
const GLYPHS: Record<AgentAppIconId, ReactNode> = {
  finance: (
    <>
      <path d="M16 3.7 28 10.5a1 1 0 0 1-.5 1.9h-23a1 1 0 0 1-.5-1.9L16 3.7Z" />
      <rect x="6" y="14" width="4" height="10" rx=".8" />
      <rect x="14" y="14" width="4" height="10" rx=".8" />
      <rect x="22" y="14" width="4" height="10" rx=".8" />
      <rect x="4" y="26" width="24" height="2.5" rx="1.25" />
    </>
  ),
  wallet: (
    <>
      <path d="M7 6.5h17a2 2 0 0 1 2 2v1H7a1.5 1.5 0 0 1 0-3Z" opacity=".72" />
      <path fillRule="evenodd" d="M7 11h19a2 2 0 0 1 2 2v11a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V10.5A3.5 3.5 0 0 0 7 11Zm14 4a3.5 3.5 0 0 0 0 7h7v-7h-7Z" />
      <path d="M21 16.8H28v3.4h-7a1.7 1.7 0 1 1 0-3.4Z" />
    </>
  ),
  location: (
    <path fillRule="evenodd" d="M16 3.5A10 10 0 0 0 6 13.5c0 6.9 8.1 14.3 9.3 15.4a1 1 0 0 0 1.4 0C17.9 27.8 26 20.4 26 13.5a10 10 0 0 0-10-10Zm0 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Z" />
  ),
  ria: (
    <>
      <circle cx="16" cy="9" r="4.2" />
      <circle cx="6.5" cy="13" r="3.1" opacity=".8" />
      <circle cx="25.5" cy="13" r="3.1" opacity=".8" />
      <path d="M16 15c-5 0-8 3.6-8 8.5v2a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-2c0-4.9-3-8.5-8-8.5Z" />
      <path d="M7.2 17.5c-3.3-.4-5.7 2.1-5.7 5.5v1a1 1 0 0 0 1 1H6v-1.5c0-2.4.4-4.4 1.2-6Zm17.6 0c3.3-.4 5.7 2.1 5.7 5.5v1a1 1 0 0 1-1 1H26v-1.5c0-2.4-.4-4.4-1.2-6Z" opacity=".8" />
    </>
  ),
  gmail: (
    <>
      <path d="M5.2 7h21.6a2.2 2.2 0 0 1 1.6.7L17.5 16a2.5 2.5 0 0 1-3 0L3.6 7.7A2.2 2.2 0 0 1 5.2 7Z" />
      <path d="M3 10.2V23a2 2 0 0 0 .6 1.4l8.1-7.6L3 10.2Zm26 0V23a2 2 0 0 1-.6 1.4l-8.1-7.6 8.7-6.6ZM13.4 18.1l.2.2a4 4 0 0 0 4.8 0l.2-.2 7.3 6.9H6.1l7.3-6.9Z" />
    </>
  ),
  calendar: (
    <>
      <path d="M7 5.5h18a3 3 0 0 1 3 3V11H4V8.5a3 3 0 0 1 3-3Z" opacity=".75" />
      <path d="M9 4v4m14-4v4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path fillRule="evenodd" d="M4 13h24v12a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V13Zm5 3v3h3v-3H9Zm5.5 0v3h3v-3h-3Zm5.5 0v3h3v-3h-3ZM9 21.5v3h3v-3H9Zm5.5 0v3h3v-3h-3Zm5.5 0v3h3v-3h-3Z" />
    </>
  ),
  email: (
    <>
      <path fillRule="evenodd" d="M5 6h22a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Zm6 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm-5 11h10a5 5 0 0 0-10 0Zm13-10v2h7v-2h-7Zm0 5v2h5v-2h-5Z" />
    </>
  ),
  pkm: (
    <>
      <path d="m8 9 16 4M8 9l7 16m9-12-9 12" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
      <circle cx="8" cy="9" r="4.5" />
      <circle cx="24" cy="13" r="4.5" />
      <circle cx="15" cy="25" r="4.5" />
    </>
  ),
  consent: (
    <>
      <path d="M10 14V10a6 6 0 0 1 12 0v4" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path fillRule="evenodd" d="M8 13h16a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3Zm8 4a2.6 2.6 0 0 0-1 5v2.5a1 1 0 0 0 2 0V22a2.6 2.6 0 0 0-1-5Z" />
    </>
  ),
  marketplace: (
    <>
      <path d="M7 5h18l3 7H4l3-7Z" />
      <path d="M4 14h7v.5a3.5 3.5 0 0 1-7 0V14Zm8.5 0h7v.5a3.5 3.5 0 0 1-7 0V14Zm8.5 0h7v.5a3.5 3.5 0 0 1-7 0V14Z" opacity=".8" />
      <path fillRule="evenodd" d="M6 19.8a5 5 0 0 0 5-1.1 5 5 0 0 0 10 0 5 5 0 0 0 5 1.1V27H6v-7.2ZM9 21v3h7v-3H9Zm10 0v6h4v-6h-4Z" />
    </>
  ),
  "connected-systems": (
    <g transform="rotate(-45 16 16)" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round">
      <path d="M13 22h-3a6 6 0 0 1 0-12h6a6 6 0 0 1 6 6" />
      <path d="M19 10h3a6 6 0 0 1 0 12h-6a6 6 0 0 1-6-6" />
      <path d="M12 16h8" />
    </g>
  ),
};

export function hasAgentAppIcon(id: string): id is AgentAppIconId {
  return Object.prototype.hasOwnProperty.call(AGENT_APP_ICON_PALETTE, id);
}

// Continuous corners soften the transition from the straight edges. Keeping
// the tile, keyline and glyph in a single SVG prevents nested/clipped icon wells.
const TILE = "M22 0h20c8.2 0 12.3 0 17 4.7S64 13.8 64 22v20c0 8.2 0 12.3-4.7 17S50.2 64 42 64H22c-8.2 0-12.3 0-17-4.7S0 50.2 0 42V22C0 13.8 0 9.7 4.7 5S13.8 0 22 0Z";

export function AgentAppIcon({
  id,
  className,
  ...props
}: Omit<SVGProps<SVGSVGElement>, "id"> & { id: AgentAppIconId }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `agent-app-${id}-${uid}`;
  const palette = AGENT_APP_ICON_PALETTE[id];

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width="64"
      height="64"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <defs>
        <linearGradient id={gradientId} x1="32" y1="0" x2="32" y2="64" gradientUnits="userSpaceOnUse">
          <stop stopColor={palette.top} />
          <stop offset="1" stopColor={palette.bottom} />
        </linearGradient>
      </defs>
      <path d={TILE} fill={`url(#${gradientId})`} />
      <path d={TILE} transform="translate(.5 .5) scale(.984375)" stroke="white" strokeOpacity=".18" />
      <g transform="translate(8 8) scale(1.5)" fill="white" color="white">
        {GLYPHS[id]}
      </g>
    </svg>
  );
}
