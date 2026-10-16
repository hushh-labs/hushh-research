export type OnboardingPerson = {
  userId: string;
  displayName: string;
  photoUrl?: string | null;
  isRia?: boolean;
  isSelf?: boolean;
};

export type CircleOnboardingProps = {
  displayName?: string | null;
  members?: readonly OnboardingPerson[];
  rosterMembers?: readonly OnboardingPerson[];
  trustedMembers?: readonly OnboardingPerson[];
  circleName?: string;
  circleReady?: boolean;
  circleCode?: string | null;
  circleFull?: boolean;
  canManageCircle?: boolean;
  canInviteMembers?: boolean;
  canInviteContacts?: boolean;
  canFindContacts?: boolean;
  source?: 'google' | 'device' | 'none';
  matching?: boolean;
  matchCount?: number | null;
  inviteReady?: boolean;
  busy?: boolean;
  membersLoading?: boolean;
  trustedLoading?: boolean;
  hasMoreTrustedMembers?: boolean;
  statusMessage?: string | null;
  circleError?: string | null;
  overflowCount?: number;
  view?: ViewName;
  onViewChange?: (view: ViewName) => void;
  nestedDialogOpen?: boolean;
  assetBaseUrl?: string;
  assetMap?: { answering?: string; connected?: string };
  theme?: 'auto' | 'light' | 'dark';
  layout?: 'auto' | 'mobile' | 'web';
  /** Host MUST use its existing acknowledge + owner-scoped return-to destination. */
  onContinue: () => void | Promise<void>;
  /** Existing service callbacks own all permissions and mutations. */
  onOpenTrusted?: () => void | Promise<unknown>;
  onChooseContacts?: () => void | Promise<unknown>;
  onInviteContacts?: () => void | Promise<unknown>;
  onFindContacts?: () => void | Promise<unknown>;
  onRetryCircle?: () => void | Promise<unknown>;
  onInviteToOne?: () => void | Promise<unknown>;
  onCopyCircleCode?: () => void | Promise<unknown>;
  onShareCircle?: () => void | Promise<unknown>;
  onRemoveMember?: (person: OnboardingPerson) => void | Promise<void>;
  onRequestRemoveMember?: (person: OnboardingPerson) => void;
  onLoadMoreMembers?: () => void | Promise<unknown>;
  onLoadMoreTrustedMembers?: () => void | Promise<unknown>;
  hasMoreMembers?: boolean;
  preview?: boolean;
  className?: string;
};

export type ViewName = 'home' | 'contacts' | 'trusted' | 'invite' | 'find';

export type IconName = 'users' | 'trusted' | 'invite' | 'arrow' | 'back' | 'check' | 'plus' | 'copy' | 'share' | 'link' | 'close' | 'google' | 'phone' | 'shield' | 'more' | 'info' | 'person' | 'lock' | 'message' | 'loading';
export type IconProps = { name: IconName; size?: number; strokeWidth?: number; className?: string; title?: string };
