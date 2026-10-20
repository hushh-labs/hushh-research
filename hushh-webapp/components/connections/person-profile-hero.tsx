import type { ReactNode } from "react";
import { ChevronRight, type FileText } from "@/components/icons";
import { HelperText, IdentityName } from "@/components/app-ui/typography";
import { SectionCard } from "@/lib/morphy-ux/ui/surface-primitives";
import { ConnectionPersonAvatar } from "./connection-person-avatar";
import styles from "./person-profile-page.module.css";

/** Presentation only. The profile keeps authority, request lifetimes and actions. */
export function PersonProfileHero({
  profile, status, options, contacts, primaryActions, tasks, footer, shareOnly = false,
}: {
  profile: { displayName: string; photoUrl?: string | null; verifiedRole?: string | null };
  shareOnly?: boolean;
  status?: ReactNode;
  options?: ReactNode;
  contacts?: ReactNode;
  primaryActions: ReactNode;
  tasks?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <SectionCard className={styles.hero}>
      <ProfileCover />
      <div className={styles.heroBody}>
        <div className={styles.identityTop}>
          <ConnectionPersonAvatar
            photoUrl={profile.photoUrl}
            label={profile.displayName}
            verified={Boolean(profile.verifiedRole)}
            size="profile"
            className={styles.avatar}
            fallbackClassName={styles.avatarFallback}
          />
          <div className={styles.identityStatus}>{status}{options}</div>
        </div>
        <div role="group" aria-label="Relationship actions">
          <div className={styles.nameActions}>
            <div className={styles.identity}>
              <IdentityName className={styles.name} dir="auto">{profile.displayName}</IdentityName>
              {profile.verifiedRole ? <HelperText className={styles.role}>{profile.verifiedRole}</HelperText> : null}
              <div className={styles.contactLines}>{contacts}</div>
            </div>
            <div className={styles.primaryActions} data-share-only={shareOnly}>{primaryActions}</div>
          </div>
          <div className={styles.actionCards}>{tasks}</div>
          <div className={styles.heroFooter}>{footer}</div>
        </div>
      </div>
    </SectionCard>
  );
}

export function PersonProfileTaskContent({ label, Icon, tone }: {
  label: string;
  Icon: typeof FileText;
  tone: "blue" | "pink" | "lilac" | "amber";
}) {
  const displayLabel = label === "Request scope" ? "Ask a question"
    : label === "Request cards" ? "Request a card" : label;
  return (
    <span className={styles.actionCardContent} data-tone={tone}>
      <span className={styles.actionIconWell}><Icon className={styles.actionIcon} aria-hidden="true" /></span>
      <span className={styles.actionLabel}>{displayLabel}</span>
      <ChevronRight className={styles.actionArrow} aria-hidden="true" />
    </span>
  );
}

export function PersonProfileEmptyState({ icon, label, description }: {
  icon: ReactNode;
  label: string;
  description?: string;
}) {
  return (
    <SectionCard className={styles.empty}>
      <span className={styles.emptyIcon} aria-hidden="true">{icon}</span>
      <HelperText>{label}</HelperText>
      {description ? <p className="sr-only">{description}</p> : null}
    </SectionCard>
  );
}

/** Original v16 artwork; separate canvases preserve every shape on phone. */
function ProfileCover() {
  return (
    <div className={styles.cover} aria-hidden="true">
      <svg className={styles.coverWide} viewBox="0 0 824 128" preserveAspectRatio="none" focusable="false">
        <rect width="824" height="128" className={styles.coverBase} />
        <rect x="336" y="22" width="224" height="84" rx="42" className={styles.coverPink} />
        <rect x="508" y="22" width="128" height="84" rx="42" className={styles.coverLilac} />
        <circle cx="670" cy="64" r="42" className={styles.coverYellow} />
        <path d="M730 24h28a40 40 0 0 1 0 80h-28Z" className={styles.coverMint} />
      </svg>
      <svg className={styles.coverPhone} viewBox="0 0 358 94" preserveAspectRatio="none" focusable="false">
        <rect width="358" height="94" className={styles.coverBase} />
        <rect x="112" y="18" width="106" height="58" rx="29" className={styles.coverPink} />
        <rect x="187" y="18" width="64" height="58" rx="29" className={styles.coverLilac} />
        <circle cx="271" cy="47" r="29" className={styles.coverYellow} />
        <path d="M313 20h8a27 27 0 0 1 0 54h-8Z" className={styles.coverMint} />
      </svg>
    </div>
  );
}
