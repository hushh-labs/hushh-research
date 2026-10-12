import type { ReactNode, SVGProps } from "react";

type AccountIconProps = SVGProps<SVGSVGElement> & {
  size?: number | string;
};

function AccountIcon({
  children,
  size = 24,
  className,
  ...props
}: AccountIconProps & { children: ReactNode }) {
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
      className={["profile-account-line-icon", className]
        .filter(Boolean)
        .join(" ")}
      {...props}
    >
      {children}
    </svg>
  );
}

export function ProfileAccountNameIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <circle className="profile-account-icon-accent" cx="12" cy="8" r="3.5" />
      <path d="M4.5 20.5c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4" />
    </AccountIcon>
  );
}

export function ProfileAccountMailIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path className="profile-account-icon-accent" d="m5 8 7 5 7-5" />
    </AccountIcon>
  );
}

export function ProfileAccountPhoneIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />
      <path
        className="profile-account-icon-accent"
        d="M17.5 2.5a4.5 4.5 0 0 1 4.5 4.5M17.5 5.2a2.3 2.3 0 0 1 2.3 2.3"
      />
    </AccountIcon>
  );
}

export function ProfileAccountProviderIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path
        className="profile-account-icon-accent"
        d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h3A1.5 1.5 0 0 1 15 6.5V8"
      />
      <rect x="3.5" y="8" width="17" height="12" rx="2.5" />
      <path d="M3.5 12.8h17" />
    </AccountIcon>
  );
}

export function ProfileAccountWalletIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <rect x="3" y="6" width="18" height="14" rx="3" />
      <circle
        className="profile-account-icon-accent-fill"
        cx="17.5"
        cy="13"
        r="1.2"
        stroke="none"
      />
    </AccountIcon>
  );
}

export function ProfileAccountResetIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 1 2.2 5.3" />
      <path
        className="profile-account-icon-accent"
        d="M6.8 15.5 4.5 17.8 7 19.4"
      />
    </AccountIcon>
  );
}

export function ProfileAccountDeleteIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="M4.5 6.5h15M9.5 6V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4A1.3 1.3 0 0 1 14.5 4.8V6" />
      <path d="M6.5 6.5l.8 12a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9l.8-12M10 10.5v6M14 10.5v6" />
    </AccountIcon>
  );
}

/** Payouts and pricing share the account screen's outline and accent. */
export function ProfileAccountBankIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="m3 8 9-5 9 5H3ZM4 20h16M5 17h14M6 9v7M10 9v7M14 9v7M18 9v7" />
      <path className="profile-account-icon-accent" d="M12 5.8h.01" />
    </AccountIcon>
  );
}

export function ProfileAccountPriceIcon(props: AccountIconProps) {
  return (
    <AccountIcon {...props}>
      <path d="M3.5 4h8l9 9-7.5 7.5-9.5-9.5V4Z" />
      <circle className="profile-account-icon-accent" cx="8" cy="8.5" r="1.5" />
    </AccountIcon>
  );
}
