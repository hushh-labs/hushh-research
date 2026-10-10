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
      className={["profile-pane-icon text-[color:var(--ios-account-label)] [&_.profile-pane-icon-accent]:stroke-[var(--ios-account-accent)] [&_.profile-pane-icon-accent-fill]:fill-[var(--ios-account-accent)]", className].filter(Boolean).join(" ")}
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

export function ProfilePaneCardIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path className="profile-pane-icon-accent" d="M3 9h18" />
      <path d="M7 15h3M14 15h3" />
    </PaneIcon>
  );
}

export function ProfilePaneCardNetworkIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="m3 8 9-5 9 5H3ZM3 21h18M5 18h14" />
      <path className="profile-pane-icon-accent" d="M6 11v7M12 11v7M18 11v7" />
    </PaneIcon>
  );
}

export function ProfilePaneCalendarIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 10h16M8 14h2M14 14h2M8 17h2" />
      <path className="profile-pane-icon-accent" d="M8 3v4M16 3v4" />
    </PaneIcon>
  );
}

export function ProfilePaneKeyIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <circle cx="15.5" cy="8.5" r="5.5" />
      <path d="m11.6 12.4-8.6 8.6v-4l7.3-7.3" />
      <path className="profile-pane-icon-accent" d="M16 7h.01M6 18v-3h3" />
    </PaneIcon>
  );
}

export function ProfilePaneGlobeIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <ellipse className="profile-pane-icon-accent" cx="12" cy="12" rx="4" ry="9" />
    </PaneIcon>
  );
}

export function ProfilePaneWalletIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><path d="M20 7H5a2 2 0 0 1 0-4h13v4M3 5v14a2 2 0 0 0 2 2h15V7" /><path className="profile-pane-icon-accent" d="M20 11h-5v6h5M17 14h.01" /></PaneIcon>;
}

export function ProfilePanePreviewIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle className="profile-pane-icon-accent" cx="12" cy="12" r="3" /></PaneIcon>;
}

export function ProfilePanePreviewOffIcon(props: ProfilePaneIconProps) {
  return (
    <PaneIcon {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      <path className="profile-pane-icon-accent" d="m3 3 18 18" />
    </PaneIcon>
  );
}

export function ProfilePaneEditIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><path d="M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7" /><path className="profile-pane-icon-accent" d="m16 3 5 5-10 10-5 1 1-5L17 4M14 6l5 5" /></PaneIcon>;
}

export function ProfilePanePauseIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><circle cx="12" cy="12" r="9" /><path className="profile-pane-icon-accent" d="M9 8v8M15 8v8" /></PaneIcon>;
}

export function ProfilePaneResumeIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><circle cx="12" cy="12" r="9" /><path className="profile-pane-icon-accent" d="m10 8 6 4-6 4Z" /></PaneIcon>;
}

export function ProfilePaneRotateIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><path d="M4 9a8 8 0 0 1 13-3l3 3M20 15a8 8 0 0 1-13 3l-3-3" /><path className="profile-pane-icon-accent" d="M20 3v6h-6M4 21v-6h6" /></PaneIcon>;
}

export function ProfilePaneDeleteIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props} stroke="var(--app-destructive)"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></PaneIcon>;
}

export function ProfilePaneScanIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><path d="M3 8V3h5M16 3h5v5M21 16v5h-5M8 21H3v-5" /><path className="profile-pane-icon-accent" d="M7 7h4v4H7zM15 7h2v4h-2M7 15h4v2H7M15 15h2v2h-2" /></PaneIcon>;
}

export function ProfilePaneHistoryIcon(props: ProfilePaneIconProps) {
  return <PaneIcon {...props}><circle cx="12" cy="12" r="9" /><path className="profile-pane-icon-accent" d="M12 6v6l4 2" /></PaneIcon>;
}
