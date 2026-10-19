import { forwardRef } from "react";
import type { CanonicalIconProps } from "../legacy-ui-icons";

// Keep the supplied glyph geometry and use the same adaptive outline/accent
// colors as Profile. These icons sit directly beside names or menu labels.
export const ContactsBookIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(
  function ContactsBookIcon(
    { size = 16, weight: _weight, mirrored: _mirrored, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <svg ref={ref} width={size} height={size} viewBox="0 0 16 16" fill="none" {...props}>
        <g fill="var(--ios-account-accent)">
          <rect x="12.25" y="3.75" width="1.95" height="3" rx=".7" />
          <rect x="12.25" y="8.35" width="1.95" height="3" rx=".7" />
          <circle cx="8.5" cy="6.25" r="1.45" />
          <path d="M5.8 11.35c0-1.65 1.02-2.7 2.7-2.7s2.7 1.05 2.7 2.7v.3c0 .35-.23.55-.6.55H6.4c-.37 0-.6-.2-.6-.55z" />
        </g>
        <g stroke="var(--ios-account-label)" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="1.75" width="10.75" height="12.5" rx="1.65" />
          <path d="M4.05 1.9v12.2" />
        </g>
      </svg>
    );
  },
);

export const FindPersonSearchIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(
  function FindPersonSearchIcon(
    { size = 24, weight: _weight, mirrored: _mirrored, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ios-account-label)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <circle cx="10" cy="8" r="5" />
        <path d="M2 21a8 8 0 0 1 10.434-7.62" />
        <g stroke="var(--ios-account-accent)">
          <circle cx="18" cy="18" r="3" />
          <path d="m22 22-1.9-1.9" />
        </g>
      </svg>
    );
  },
);

export const InvitePersonPlusIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(
  function InvitePersonPlusIcon(
    { size = 24, weight: _weight, mirrored: _mirrored, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ios-account-label)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M2 21a8 8 0 0 1 13.292-6" />
        <circle cx="10" cy="8" r="5" />
        <g stroke="var(--ios-account-accent)">
          <path d="M19 16v6" />
          <path d="M22 19h-6" />
        </g>
      </svg>
    );
  },
);

export const ManageConnectionsIcon = forwardRef<SVGSVGElement, CanonicalIconProps>(
  function ManageConnectionsIcon(
    { size = 24, weight: _weight, mirrored: _mirrored, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absoluteStrokeWidth, ...props },
    ref,
  ) {
    return (
      <svg ref={ref} width={size} height={size} viewBox="0 0 24 24" fill="none" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <g stroke="var(--ios-account-label)">
          <circle cx="7" cy="7" r="2.5" />
          <path d="M2.5 19v-2a4.5 4.5 0 0 1 9 0v2" />
        </g>
        <g stroke="var(--ios-account-accent)">
          <circle cx="17" cy="7" r="2.5" />
          <path d="M12.5 19v-2a4.5 4.5 0 0 1 9 0v2" />
        </g>
      </svg>
    );
  },
);
