"use client";

import { BadgeCheck, Briefcase, Mail, MapPin, Phone, User } from "@/components/icons";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { WalletCardQr } from "./wallet-card-qr";
import type { WalletProfilePresentation } from "@/components/wallet-card/wallet-profile-presentation";
import { cn } from "@/lib/utils";
import styles from "./wallet-profile-card.module.css";

/** Shared by the Wallet face and owner preview; contains no fetching or consent decisions. */
export function WalletProfileCard({ profile, compact = false, interactiveContacts = false, className }: {
  profile: WalletProfilePresentation;
  compact?: boolean;
  interactiveContacts?: boolean;
  className?: string;
}) {
  const initials = profile.name.split(/\s+/).filter(Boolean).slice(0, 2).map(word => word[0]).join("");
  const rows = [
    { label: "Email", value: profile.email, Icon: Mail },
    { label: "Phone", value: profile.phone, Icon: Phone },
    { label: "Organization", value: profile.organization, Icon: Briefcase },
    { label: "Location", value: profile.location, Icon: MapPin },
  ].filter(row => row.value && (!compact || row.label === "Email" || row.label === "Phone"));
  return <div className={cn(styles.card, compact && styles.compact, className)} data-testid="wallet-profile-card">
    <div className={styles.identity}>
      <Avatar className={styles.avatar}>
        {profile.avatarUrl ? <AvatarImage src={profile.avatarUrl} alt="" /> : null}
        <AvatarFallback>{profile.name === "Your profile" ? <User aria-hidden="true" /> : initials}</AvatarFallback>
      </Avatar>
      <div className={styles.heading}>
        <p className={styles.name}>{profile.name}</p>
        {profile.verification === "verified" ? <p className={styles.verified}><BadgeCheck aria-hidden="true" />Verified by Hushh</p> : null}
        {profile.professionalTitle ? <p className={styles.title}>{profile.professionalTitle}</p> : null}
      </div>
    </div>
    <div className={styles.body}>
      <dl className={styles.details}>
        {rows.map(({ label, value, Icon }) => <div className={styles.row} key={label}>
          <dt><span className="sr-only">{label}</span><Icon aria-hidden="true" /></dt>
          <dd title={compact ? value! : undefined}>{interactiveContacts && (label === "Email" || label === "Phone") ? <a className={styles.contact} href={label === "Email" ? `mailto:${encodeURIComponent(value!).replace(/%40/g, "@")}` : `tel:${value!.trim().startsWith("+") ? "+" : ""}${value!.replace(/\D/g, "")}`}><span>{value}</span></a> : value}</dd>
        </div>)}
      </dl>
      {profile.authorizedProfileUrl ? <figure className={styles.qr}>
        <WalletCardQr value={profile.authorizedProfileUrl} label="Profile QR code: Scan to connect" />
        <figcaption>Scan to connect</figcaption>
      </figure> : null}
    </div>
    <div className={styles.brand} aria-label="Hussh profile">Hushh <span>Profile</span></div>
  </div>;
}
