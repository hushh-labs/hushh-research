import type { ReactNode, SVGProps } from "react";

type ProfilePaneIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

function PaneIcon({
  children,
  size = 24,
  className,
  ...props
}: ProfilePaneIconProps & { children: ReactNode }) {
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
      className={["profile-pane-icon", className].filter(Boolean).join(" ")}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ProfilePaneAccountIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <circle className="profile-pane-icon-accent" cx="12" cy="7.5" r="3.5" />
      <path d="M4.8 21c.3-4.7 3-7.1 7.2-7.1s6.9 2.4 7.2 7.1" />
    </PaneIcon>
  );
}

export function ProfilePaneAppearanceIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M6 3v18M18 3v18M12 3v18" />
      <circle className="profile-pane-icon-accent-fill" cx="6" cy="8" r="2.1" stroke="none" />
      <circle className="profile-pane-icon-accent-fill" cx="12" cy="15" r="2.1" stroke="none" />
      <circle className="profile-pane-icon-accent-fill" cx="18" cy="10" r="2.1" stroke="none" />
    </PaneIcon>
  );
}

export function ProfilePaneSecurityIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M12 2.8 20 6v5.2c0 5-3.3 8.3-8 10-4.7-1.7-8-5-8-10V6z" />
      <path className="profile-pane-icon-accent" d="m8.4 12 2.3 2.3 4.9-5" />
    </PaneIcon>
  );
}

export function ProfilePaneDevicesIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M1.8 20h20.4" />
      <path className="profile-pane-icon-accent" d="M9.5 8h5" />
    </PaneIcon>
  );
}

export function ProfilePaneConnectorsIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
      <circle className="profile-pane-icon-accent" cx="12" cy="12" r="4" />
    </PaneIcon>
  );
}

export function ProfilePaneInviteIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c.2-3.8 2.2-5.8 5.5-5.8 2 0 3.5.7 4.4 2" />
      <circle className="profile-pane-icon-accent" cx="17" cy="9" r="2.5" />
      <path className="profile-pane-icon-accent" d="M14 14.4c.8-.8 1.8-1.2 3.1-1.2 2.4 0 3.8 1.6 3.9 4.8" />
    </PaneIcon>
  );
}

export function ProfilePaneHelpIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path className="profile-pane-icon-accent" d="M9.7 9a2.5 2.5 0 1 1 4.1 1.9c-1 .7-1.8 1.2-1.8 2.6" />
      <path className="profile-pane-icon-accent" d="M12 17.3h.01" />
    </PaneIcon>
  );
}

export function ProfilePanePrivacyIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M12 2.8 20 6v5.2c0 5-3.3 8.3-8 10-4.7-1.7-8-5-8-10V6z" />
      <path className="profile-pane-icon-accent" d="M9 11v-1a3 3 0 0 1 6 0v1" />
      <path className="profile-pane-icon-accent" d="M8 11h8v6H8z" />
    </PaneIcon>
  );
}

export function ProfilePaneTermsIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M7 3h9.5L20 6.5V21H7z" />
      <path className="profile-pane-icon-accent" d="M16.5 3v3.5H20M10 11h7M10 15h7M10 19h4" />
      <path d="M4 6h3M4 10h3M4 14h3" />
    </PaneIcon>
  );
}

export function ProfilePaneSignOutIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M10 4H4v16h6" />
      <path className="profile-pane-icon-accent" d="M13 8l4 4-4 4M8 12h9" />
    </PaneIcon>
  );
}
