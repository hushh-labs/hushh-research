import type { ReactNode, SVGProps } from "react";

type SecondaryIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

/** Profile's 24px outline language, shared by nested settings screens. */
function SecondaryIcon({
  children,
  size = 24,
  className,
  ...props
}: SecondaryIconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={["profile-pane-icon", className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ProfileSecondaryFingerprintIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="M4.5 10.2V9a7.5 7.5 0 0 1 15 0v1.2" />
      <path d="M7.5 10.3V9a4.5 4.5 0 0 1 9 0v3.5" />
      <path className="profile-pane-icon-accent" d="M10.5 10V9a1.5 1.5 0 0 1 3 0v5.5" />
      <path d="M4.5 13c.1 2.8 1 5.1 2.4 7M7.5 13c.1 3.5 1.1 6 2.6 8M10.5 13c.1 3.6.9 6.2 2.1 8M16.5 15c-.1 2.4-.6 4.5-1.4 6M19.5 13c0 2.3-.4 4.4-1.2 6.3" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryPassphraseIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <circle cx="8" cy="9" r="4.5" />
      <path className="profile-pane-icon-accent" d="m11.2 12.2 8.3 8.3M16 17.1l2-2M18.2 19.3l2-2" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryRefreshIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="M19.7 10a8 8 0 0 0-13.9-4.2L4 7.6M4.3 14a8 8 0 0 0 13.9 4.2l1.8-1.8" />
      <path className="profile-pane-icon-accent" d="M4 3.7v4h4M20 20.3v-4h-4" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryInboxIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="M4.5 5h15l2 11.5V20h-19v-3.5L4.5 5Z" />
      <path className="profile-pane-icon-accent" d="M2.5 15h5l1.5 2h6l1.5-2h5" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryReceiptIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="M5 3h14v18l-2.3-1.5-2.4 1.5-2.3-1.5-2.3 1.5-2.4-1.5L5 21V3Z" />
      <path className="profile-pane-icon-accent" d="M8 8h8M8 12h8M8 16h4" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryUnlinkIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="m8.8 8.8-1.4-1.4a3.7 3.7 0 0 0-5.2 5.2l3.3 3.3a3.7 3.7 0 0 0 5.2 0l1.2-1.2" />
      <path d="m15.2 15.2 1.4 1.4a3.7 3.7 0 0 0 5.2-5.2l-3.3-3.3a3.7 3.7 0 0 0-5.2 0l-1.2 1.2" />
      <path className="profile-pane-icon-accent" d="m8 3.3 1 2.8M15 17.9l1 2.8M3.4 20.6l2.8-1M17.8 4.4l2.8-1" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryLocationIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12Z" />
      <circle className="profile-pane-icon-accent" cx="12" cy="9" r="2.4" />
    </SecondaryIcon>
  );
}

export function ProfileSecondaryVisibilityIcon(props: SecondaryIconProps) {
  return (
    <SecondaryIcon {...props}>
      <path d="M2.8 12s3.5-6 9.2-6 9.2 6 9.2 6-3.5 6-9.2 6-9.2-6-9.2-6Z" />
      <circle className="profile-pane-icon-accent" cx="12" cy="12" r="2.8" />
    </SecondaryIcon>
  );
}
