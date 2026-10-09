import type { ReactNode, SVGProps } from "react";

type InnerIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

/** The same 24px, 1.8px line language as the Profile menu artwork. */
function InnerIcon({
  children,
  size = 24,
  className,
  ...props
}: InnerIconProps & { children: ReactNode }) {
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

export function ProfileInnerLinkIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <path d="m9.2 14.8-1.8 1.8a3.7 3.7 0 0 1-5.2-5.2l3.4-3.4a3.7 3.7 0 0 1 5.2 0" />
      <path d="m14.8 9.2 1.8-1.8a3.7 3.7 0 0 1 5.2 5.2l-3.4 3.4a3.7 3.7 0 0 1-5.2 0" />
      <path className="profile-pane-icon-accent" d="m8.5 15.5 7-7" />
    </InnerIcon>
  );
}

export function ProfileInnerJoinIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 19c.3-3.8 2.3-5.7 6-5.7 1.8 0 3.2.5 4.2 1.6" />
      <path className="profile-pane-icon-accent" d="M18 12v8M14 16h8" />
    </InnerIcon>
  );
}

export function ProfileInnerAgentIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <path d="M4 5.5h16v11H9l-5 3v-14Z" />
      <path className="profile-pane-icon-accent" d="M8 11h.01M12 11h.01M16 11h.01" />
    </InnerIcon>
  );
}

export function ProfileInnerQualifiedIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <path d="M12 2.8 14.7 5l3.4-.1.8 3.3 2.3 2.7-1.8 2.9.3 3.4-3.4.9L12 21l-2.9-2.9-3.4-.9.3-3.4-1.8-2.9 2.3-2.7.8-3.3 3.4.1Z" />
      <path className="profile-pane-icon-accent" d="m8.7 11.8 2.2 2.2 4.5-4.7" />
    </InnerIcon>
  );
}

export function ProfileInnerSuccessIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path className="profile-pane-icon-accent" d="m8.4 12 2.4 2.4 4.9-5" />
    </InnerIcon>
  );
}

export function ProfileInnerPeopleIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <circle cx="9" cy="8" r="3" />
      <path d="M2.8 19c.3-3.8 2.4-5.7 6.2-5.7s5.9 1.9 6.2 5.7" />
      <circle className="profile-pane-icon-accent" cx="17.3" cy="9" r="2.5" />
      <path className="profile-pane-icon-accent" d="M16.7 14.1c2.7-.2 4.3 1.5 4.5 4.9" />
    </InnerIcon>
  );
}

export function ProfileInnerProgressIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path className="profile-pane-icon-accent" d="M12 6.8V12l3.6 2.3" />
    </InnerIcon>
  );
}

export function ProfileInnerReviewIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <path d="M8 4H5v17h14V4h-3M9 3h6v3H9z" />
      <path className="profile-pane-icon-accent" d="m8 12 1.5 1.5 2.5-3M14 12h2.5M8 17h8.5" />
    </InnerIcon>
  );
}

export function ProfileInnerWarningIcon(props: InnerIconProps) {
  return (
    <InnerIcon {...props}>
      <path d="m12 3 9.2 16H2.8L12 3Z" />
      <path className="profile-pane-icon-accent" d="M12 9v4.5M12 17h.01" />
    </InnerIcon>
  );
}
